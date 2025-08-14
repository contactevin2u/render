require("dotenv").config();
const { Pool } = require("pg");
const isProd = process.env.NODE_ENV === "production";
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: isProd ? true : { rejectUnauthorized:false }});

const sql = `
CREATE TABLE IF NOT EXISTS deliveries (
  id               uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  order_id         uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  kind             text NOT NULL DEFAULT 'delivery' CHECK (kind IN ('delivery','collection','service')),
  status           text NOT NULL DEFAULT 'scheduled'
                   CHECK (status IN ('scheduled','assigned','enroute','delivered','returned','failed','cancelled')),
  scheduled_for    timestamptz NOT NULL,
  recipient_name   text,
  recipient_phone  text,
  dropoff_address  text,
  signature_svg    text,
  pod_photo_url    text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_deliv_order  ON deliveries(order_id);
CREATE INDEX IF NOT EXISTS idx_deliv_status ON deliveries(status);

CREATE TABLE IF NOT EXISTS delivery_events (
  id           uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  delivery_id  uuid NOT NULL REFERENCES deliveries(id) ON DELETE CASCADE,
  event        text NOT NULL,
  at           timestamptz NOT NULL DEFAULT now(),
  meta         jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS idx_devents_delivery ON delivery_events(delivery_id);
`;

(async ()=>{
  try { await pool.query(sql); console.log("✅ deliveries + delivery_events ready"); }
  catch(e){ console.error("❌ failed:", e.message); process.exit(1); }
  finally{ await pool.end(); }
})();
