const toYMD = (v)=> (typeof v==="string" ? v.slice(0,10) : (isNaN(new Date(v)) ? null : new Date(v).toISOString().slice(0,10)));
const MY_TZ = process.env.TZ || "Asia/Kuala_Lumpur"; const dateStrInTZ = (d = new Date()) => new Intl.DateTimeFormat("en-CA", { timeZone: MY_TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(d); const asUTCmidnight = (yyyy_mm_dd) => new Date(yyyy_mm_dd + "T00:00:00Z");
require("dotenv").config();
const express = require("express");
const { Pool } = require("pg");
const { randomUUID } = require("crypto");
const cors = require("cors");

const app = express();
const PORT = Number(process.env.PORT || 10000);
app.use(express.json({ limit: "2mb" }));

// Allow localhost (dev) + your future Vercel domain via env
const ALLOW = (process.env.CORS_ORIGIN || "http://localhost:3000")
  .split(",")
  .map(s => s.trim());

app.use(cors({
  origin(origin, cb) {
    if (!origin) return cb(null, true); // curl/Postman
    cb(null, ALLOW.includes(origin));
  },
  credentials: true,
  methods: ["GET","POST","PATCH","DELETE","OPTIONS"],
  allowedHeaders: ["Content-Type","Authorization","X-Request-Id"]
}));

// DB setup
const isProd = process.env.NODE_ENV === "production";
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: isProd ? true : { rejectUnauthorized: false }
});

// -------- Health ----------
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

// -------- Orders ----------
app.post("/api/orders", async (req, res) => {
  const b = req.body || {};
  if (!b.customer_name || !b.customer_phone_primary || !b.order_type || !Array.isArray(b.line_items) || b.line_items.length === 0)
    return res.status(400).json({ error: "missing required fields" });

  const toCents = (n) => Math.round(Number(n) * 100);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // customer upsert (by phone)
    let customer_id;
    const found = await client.query("SELECT id FROM customers WHERE phone_primary=$1 LIMIT 1", [b.customer_phone_primary]);
    if (found.rows[0]) {
      customer_id = found.rows[0].id;
      if (b.customer_address) await client.query("UPDATE customers SET default_address=$1 WHERE id=$2", [b.customer_address, customer_id]);
    } else {
      const ins = await client.query("INSERT INTO customers (name, phone_primary, default_address) VALUES ($1,$2,$3) RETURNING id", [b.customer_name, b.customer_phone_primary, b.customer_address || null]);
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

app.get("/api/orders", async (_req, res) => {
  const sql = `
    SELECT o.id, o.order_code, o.order_type, o.status, o.created_at,
           c.name AS customer_name,
           COALESCE(SUM(oli.total_cents),0) AS total_cents
    FROM orders o
    JOIN customers c ON c.id = o.customer_id
    LEFT JOIN order_line_items oli ON oli.order_id = o.id
    GROUP BY o.id, c.name
    ORDER BY o.created_at DESC
    LIMIT 50
  `;
  const { rows } = await pool.query(sql);
  res.json(rows.map(r => ({ ...r, total_myr: Number(r.total_cents) / 100 })));
});

// -------- Transactions ----------
app.post("/api/transactions", async (req, res) => {
  const b = req.body || {};
  const amt = Number(b.amount_myr);
  const amountProvided = b.amount_myr !== undefined && b.amount_myr !== null && Number.isFinite(amt);
  if (!b.order_id || !b.type || !amountProvided) {
    return res.status(400).json({ error: "order_id, type, amount_myr required" });
  }
  if (amt < 0) {
    return res.status(400).json({ error: "amount_myr cannot be negative" });
  }
  const amount_cents = Math.round(amt * 100);
  try {
    await pool.query(
      `INSERT INTO transactions (order_id, type, method, amount_cents, reference, notes)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [b.order_id, b.type, b.method || null, amount_cents, b.reference || null, b.notes || null]
    );
    res.status(201).json({ ok: true });
  } catch (e) {
    console.error("[tx]", e.message);
    res.status(400).json({ error: e.message });
  }
});

// -------- Outstanding ----------
//
// -------- Schedules (recurring payments) ----------
app.post("/api/schedules", async (req, res) => {
  const b = req.body || {};
  if (!b.order_id || !b.schedule_type || !b.frequency || b.amount_myr === undefined || !b.next_due_date)
    return res.status(400).json({ error: "missing required fields" });

  const amount_cents = Math.round(Number(b.amount_myr) * 100);
  try {
    const r = await pool.query(
      `INSERT INTO recurring_schedules (order_id, schedule_type, frequency, amount_cents, total_cycles, next_due_date, grace_days)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       RETURNING id`,
      [b.order_id, b.schedule_type, b.frequency, amount_cents, b.total_cycles || null, b.next_due_date, b.grace_days || 3]
    );
    res.status(201).json({ schedule_id: r.rows[0].id });
  } catch (e) {
    console.error("[add-schedule]", e.message);
    res.status(400).json({ error: e.message });
  }
});
app.get("/api/outstanding", async (req, res) => {
  const type = req.query.type;
  const dueBefore = req.query.due_before || new Date().toISOString().slice(0, 10); 
  const overdueOnly = String(req.query.overdue_only || "false").toLowerCase() === "true";

  const params = [dueBefore];
  let where = "s.status='active' AND s.next_due_date <= $1";
  if (type) { params.push(type); where += ` AND s.schedule_type = $${params.length}`; }

  const sql = `
    SELECT s.id AS schedule_id, s.order_id, s.schedule_type, s.frequency, s.amount_cents,
           s.next_due_date, s.grace_days,
           o.order_code, c.name AS customer_name, c.phone_primary
    FROM recurring_schedules s
    JOIN orders o ON o.id = s.order_id
    JOIN customers c ON c.id = o.customer_id
    WHERE ${where}
    ORDER BY s.next_due_date ASC
  `;
  const { rows: schedules } = await pool.query(sql, params);

  const today = new Date(dueBefore + "T00:00:00Z");
  const out = [];

  for (const s of schedules) {
    const freqDays = s.frequency === "weekly" ? 7 : 30;
    const cycleStart = new Date(new Date(s.next_due_date).getTime() - freqDays * 86400000);

    const pays = await pool.query(
      `SELECT COALESCE(SUM(amount_cents),0) AS paid
       FROM transactions
       WHERE order_id=$1 AND type IN ('payment','deposit')
         AND paid_at BETWEEN $2 AND ($3::date + interval '1 day')`,
      [s.order_id, cycleStart, dueBefore]
    );
    const paid = Number(pays.rows[0].paid || 0);
    const due = Number(s.amount_cents);
    const outstanding = Math.max(due - paid, 0);

    const dueStr = toYMD(s.next_due_date); const dueUTC = asUTCmidnight(dueStr); const daysLate = Math.floor((+today - +dueUTC) / 86400000) - Number(s.grace_days || 0);
    let bucket = "current";
    if (daysLate > 0 && daysLate <= 7) bucket = "1-7";
    else if (daysLate >= 8 && daysLate <= 30) bucket = "8-30";
    else if (daysLate > 30) bucket = ">30";

    if (!overdueOnly || outstanding > 0) {
      out.push({
        order_id: s.order_id,
        order_code: s.order_code,
        schedule_id: s.schedule_id,
        schedule_type: s.schedule_type,
        frequency: s.frequency,
        amount_myr: due / 100,
        due_date: s.next_due_date,
        customer_name: s.customer_name,
        phone: s.phone_primary,
        outstanding_myr: outstanding / 100,
        days_late: Math.max(daysLate, 0),
        bucket
      });
    }
  }
  res.json(out);
});

// Listen
app.listen(PORT, () => {
  console.log(`API running on port ${PORT}`);
});



