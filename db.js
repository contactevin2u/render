const { Pool } = require("pg");

// Render external Postgres needs SSL from local dev.
// rejectUnauthorized:false is fine for dev; for prod, prefer proper CA.
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

module.exports = { pool };
