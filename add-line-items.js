require("dotenv").config();
const { Pool } = require("pg");
const isProd = process.env.NODE_ENV === "production";
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: isProd ? true : { rejectUnauthorized:false }});

const sql = `
CREATE TABLE IF NOT EXISTS order_line_items (
  id                uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  order_id          uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_code      text NOT NULL,
  description       text NOT NULL,
  qty               integer NOT NULL CHECK (qty > 0),
  unit_price_cents  bigint  NOT NULL CHECK (unit_price_cents >= 0),
  total_cents       bigint  NOT NULL CHECK (total_cents >= 0),
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_items_order ON order_line_items(order_id);
`;

(async ()=>{
  try {
    await pool.query(sql);
    console.log("✅ order_line_items created/exists");
  } catch (e) {
    console.error("❌ failed:", e.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
})();
