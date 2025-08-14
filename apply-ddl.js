require("dotenv").config();
const fs = require("fs");
const { Pool } = require("pg");

(async () => {
  if (!process.env.DATABASE_URL) {
    console.error("Missing DATABASE_URL in .env");
    process.exit(1);
  }
  const isProd = process.env.NODE_ENV === "production";
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: isProd ? true : { rejectUnauthorized: false }
  });

  let sql = fs.readFileSync("./ddl.sql", "utf8");
  // Strip UTF-8 BOM if present
  if (sql.charCodeAt(0) === 0xFEFF) sql = sql.slice(1);

  try {
    await pool.query(sql);
    console.log("✅ DDL applied successfully");
  } catch (e) {
    console.error("❌ DDL failed:", e.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
})();
