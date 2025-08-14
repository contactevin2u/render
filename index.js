require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");
const { randomUUID } = require("crypto");
const OpenAI = require("openai");

// ---------- Timezone helpers (MYT-aware, date-only) ----------
const toYMD = (v) =>
  (typeof v === "string" ? v.slice(0, 10) : (isNaN(new Date(v)) ? null : new Date(v).toISOString().slice(0, 10)));
const MY_TZ = process.env.TZ || "Asia/Kuala_Lumpur";
const dateStrInTZ = (d = new Date()) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: MY_TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
const asUTCmidnight = (yyyy_mm_dd) => new Date(yyyy_mm_dd + "T00:00:00Z");

// ---------- App & CORS ----------
const app = express();
const PORT = Number(process.env.PORT || 10000);
app.use(express.json({ limit: "2mb" }));

const ALLOW = (process.env.CORS_ORIGIN || "http://localhost:3000").split(",").map(s => s.trim());
app.use(cors({
  origin(origin, cb) {
    if (!origin) return cb(null, true); // curl/Postman
    cb(null, ALLOW.includes(origin));
  },
  credentials: true,
  methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "X-Request-Id"]
}));

// ---------- DB ----------
const isProd = process.env.NODE_ENV === "production";
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// ---------- Health ----------
app.get("/api/health", (_req, res) => res.json({ ok: true, time: new Date().toISOString() }));
app.get("/api/db-health", async (_req, res) => {
  try {
    const r = await pool.query("select now() as now");
    res.json({ ok: true, db_time: r.rows[0].now });
  } catch (e) {
    console.error("[db-health]", e.message);
    res.status(503).json({ ok: false, error: e.message });
  }
});

// ---------- Orders ----------
app.post("/api/orders", async (req, res) => {
  const b = req.body || {};
  if (!b.customer_name || !b.customer_phone_primary || !b.order_type || !Array.isArray(b.line_items) || b.line_items.length === 0) {
    return res.status(400).json({ error: "missing required fields" });
  }

  const toCents = (n) => Math.round(Number(n) * 100);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // customer upsert (by phone)
    let customer_id;
    const found = await client.query(
      "SELECT id FROM customers WHERE phone_primary=$1 LIMIT 1",
      [b.customer_phone_primary]
    );
    if (found.rows[0]) {
      customer_id = found.rows[0].id;
      if (b.customer_address) {
        await client.query(
          "UPDATE customers SET default_address=$1 WHERE id=$2",
          [b.customer_address, customer_id]
        );
      }
    } else {
      const ins = await client.query(
        "INSERT INTO customers (name, phone_primary, default_address) VALUES ($1,$2,$3) RETURNING id",
        [b.customer_name, b.customer_phone_primary, b.customer_address || null]
      );
      customer_id = ins.rows[0].id;
    }

    // Create order
    const order_id = randomUUID();
    const order_code = "ORD-" + order_id.slice(0, 8).toUpperCase();
    await client.query(
      `INSERT INTO orders (id, customer_id, order_code, order_type, status)
       VALUES ($1,$2,$3,$4,'pending')`,
      [order_id, customer_id, order_code, b.order_type]
    );

    // Insert line items
    for (const li of b.line_items) {
      const unit = toCents(li.unit_price_myr || 0);
      const qty = Number(li.qty || 0);
      if (!li.product_code || !li.description || qty <= 0) throw new Error("invalid line item");
      const total = unit * qty;
      await client.query(
        `INSERT INTO order_line_items (order_id, product_code, description, qty, unit_price_cents, total_cents)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [order_id, li.product_code, li.description, qty, unit, total]
      );
    }

    await client.query("COMMIT");
    res.status(201).json({ order_id, order_code });
  } catch (e) {
    await client.query("ROLLBACK");
    console.error("[create-order]", e.message);
    res.status(400).json({ error: e.message });
  } finally {
    client.release();
  }
});

// ---------- AI Intake Parsing (OpenAI) ----------
const oaClient = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const intakeSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    customer_name: { type: "string" },
    customer_address: { type: "string" },
    customer_phone_primary: { type: "string" },
    customer_phone_secondary: { type: "string" },
    order_type: { enum: ["outright_purchase", "instalment", "rent"] },
    line_items: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          product_code: { type: "string" },
          description: { type: "string" },
          qty: { type: "number" },
          unit_price_myr: { type: "number" }
        },
        required: ["description", "qty"],
      }
    },
    delivery_type: { enum: ["one_way", "two_way"] },
    action_type: { enum: ["new_order", "cancel_instalment", "terminate_rental", "buy_back"] },
    original_order_id: { type: "string" }
  },
  required: ["customer_name", "customer_phone_primary", "order_type", "line_items"]
};

// Helper to map Malay keywords if model misses it (belt & braces)
function coerceOrderType(s) {
  if (!s) return "outright_purchase";
  const t = s.toLowerCase();
  if (/(sewa|rental)/.test(t)) return "rent";
  if (/(ansur|instal)/.test(t)) return "instalment";
  if (/(beli|purchase|outright)/.test(t)) return "outright_purchase";
  return "outright_purchase";
}

app.post("/api/intake/parse", async (req, res) => {
  try {
    if (!process.env.OPENAI_API_KEY) {
      return res.status(400).json({ error: "OPENAI_API_KEY is required" });
    }

    const rawText = (req.body?.text || req.body?.message || "").toString();
    if (!rawText.trim()) return res.status(400).json({ error: "Provide { text }" });

    const autoCreate = String(req.query.create ?? req.body?.auto_create ?? "true").toLowerCase() === "true";

    const system = [
      "You convert unstructured WhatsApp chats (English or Malay) into a strict JSON object matching the JSON schema.",
      "If a field is unknown, omit it. Never fabricate products or prices.",
      "Map Malay keywords: 'beli'→outright_purchase, 'ansuran'→instalment, 'sewa'→rent.",
      "Normalize Malaysian phone numbers (drop spaces/dashes). Currency is in MYR.",
      "For line items: description (required), qty (default 1 if inferred), unit_price_myr if price given.",
      "Return JSON only; no commentary."
    ].join(" ");

    const user = `Chat transcript:\n---\n${rawText}\n---\nReturn JSON only.`;

    const resp = await oaClient.responses.create({
      model: "gpt-4o-mini", // cost-effective; change if you prefer another
      instructions: system,
      input: user,
      text: { format: "json_schema", json_schema: { name: "oms_order", schema: intakeSchema, strict: true } }
    });

    // Robust parse
    let parsed;
    try {
      if (resp && resp.output_text) {
        parsed = JSON.parse(resp.output_text);
      } else {
        const maybe = resp?.output?.[0]?.content?.[0];
        if (maybe?.type === "output_text") parsed = JSON.parse(maybe.text);
      }
    } catch {
      throw new Error("Model returned non-JSON or invalid JSON");
    }

    if (!parsed || typeof parsed !== "object") {
      return res.status(400).json({ error: "Parser returned empty" });
    }

    // Coerce/clean minimal fields
    parsed.order_type = coerceOrderType(parsed.order_type);
    if (!Array.isArray(parsed.line_items) || parsed.line_items.length === 0) {
      return res.status(400).json({ error: "No line_items parsed" });
    }
    // ensure product_code + qty + unit_price_myr defaults
    parsed.line_items = parsed.line_items.map((li, idx) => ({
      product_code: li.product_code || "PARSED-" + (idx + 1),
      description: li.description,
      qty: Number(li.qty || 1),
      unit_price_myr: (li.unit_price_myr !== undefined && li.unit_price_myr !== null) ? Number(li.unit_price_myr) : 0
    }));

    // If not auto-creating, just return parsed JSON
    if (!autoCreate) return res.json({ parsed, created: false });

    // Auto-create order using same logic as /api/orders
    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      // upsert customer
      let customer_id;
      const found = await client.query(
        "SELECT id FROM customers WHERE phone_primary=$1 LIMIT 1",
        [parsed.customer_phone_primary]
      );
      if (found.rows[0]) {
        customer_id = found.rows[0].id;
        if (parsed.customer_address) {
          await client.query(
            "UPDATE customers SET default_address=$1, name=COALESCE(NULLIF($2,''), name) WHERE id=$3",
            [parsed.customer_address, parsed.customer_name || "", customer_id]
          );
        }
      } else {
        const ins = await client.query(
          "INSERT INTO customers (name, phone_primary, default_address) VALUES ($1,$2,$3) RETURNING id",
          [parsed.customer_name || "Unknown", parsed.customer_phone_primary, parsed.customer_address || null]
        );
        customer_id = ins.rows[0].id;
      }

      const order_id = randomUUID();
      const order_code = "ORD-" + order_id.slice(0, 8).toUpperCase();
      await client.query(
        `INSERT INTO orders (id, customer_id, order_code, order_type, status)
         VALUES ($1,$2,$3,$4,'pending')`,
        [order_id, customer_id, order_code, parsed.order_type]
      );

      const toCents = (n) => Math.round(Number(n) * 100);
      for (const li of parsed.line_items) {
        const unit = toCents(li.unit_price_myr || 0);
        const qty = Number(li.qty || 0);
        if (!li.description || qty <= 0) throw new Error("invalid line item");
        const total = unit * qty;
        await client.query(
          `INSERT INTO order_line_items (order_id, product_code, description, qty, unit_price_cents, total_cents)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [order_id, li.product_code, li.description, qty, unit, total]
        );
      }

      await client.query("COMMIT");
      return res.status(201).json({ parsed, created: true, order_id, order_code });
    } catch (dbErr) {
      await pool.query("ROLLBACK");
      console.error("[intake-create][db]", dbErr.message);
      return res.status(400).json({ error: dbErr.message });
    } finally {
      client.release();
    }
  } catch (e) {
    console.error("[intake-parse]", e?.message || e);
    return res.status(400).json({ error: e?.message || "Parse failed" });
  }
});

// ---------- Listen ----------
app.listen(PORT, () => {
  console.log(`API running on port ${PORT}`);
});
// auto-added intake2 router
try { const intake2 = require("./routes/intake2"); app.use("/api/intake2", intake2); console.log("Mounted /api/intake2"); } catch (e) { console.error("Failed to mount /api/intake2", e); }
