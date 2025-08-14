require("dotenv").config();
const { Pool } = require("pg");
const isProd = process.env.NODE_ENV === "production";
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: isProd ? true : { rejectUnauthorized:false }});
(async ()=>{
  const r = await pool.query("select to_regclass('public.order_line_items') as exists");
  console.log("order_line_items =", r.rows[0].exists);
  await pool.end();
})();
