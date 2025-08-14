require("dotenv").config();
const { Pool } = require("pg");
const isProd = process.env.NODE_ENV === "production";
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: isProd ? true : { rejectUnauthorized:false }});

const sql = `
CREATE TABLE IF NOT EXISTS recurring_schedules (
  id                uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  order_id          uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  schedule_type     text NOT NULL CHECK (schedule_type IN ('instalment','rental')),
  frequency         text NOT NULL CHECK (frequency IN ('weekly','monthly')),
  amount_cents      bigint NOT NULL CHECK (amount_cents >= 0),
  total_cycles      integer,                    -- for instalments; NULL for rentals
  cycles_completed  integer NOT NULL DEFAULT 0,
  next_due_date     date NOT NULL,
  grace_days        integer NOT NULL DEFAULT 3,
  status            text NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','completed','cancelled')),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_sched_order   ON recurring_schedules(order_id);
CREATE INDEX IF NOT EXISTS idx_sched_nextdue ON recurring_schedules(next_due_date);

CREATE TABLE IF NOT EXISTS transactions (
  id            uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  order_id      uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  type          text NOT NULL CHECK (type IN ('payment','refund','penalty','deposit')),
  method        text CHECK (method IN ('cash','bank_transfer','card','ewallet','online','driver_collect')),
  amount_cents  bigint NOT NULL,
  reference     text,
  notes         text,
  paid_at       timestamptz NOT NULL DEFAULT now(),
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_tx_order ON transactions(order_id);
CREATE INDEX IF NOT EXISTS idx_tx_paid  ON transactions(paid_at);
`;

(async ()=>{
  try { await pool.query(sql); console.log("✅ schedules + transactions ready"); }
  catch(e){ console.error("❌ failed:", e.message); process.exit(1); }
  finally{ await pool.end(); }
})();
