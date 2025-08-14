require("dotenv").config();
const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === "production" ? true : { rejectUnauthorized: false }
});

async function runChaseList() {
  const dueBefore = new Date().toISOString().slice(0, 10); // Get today's date in YYYY-MM-DD format

  const sql = `
    SELECT s.id AS schedule_id, s.order_id, s.schedule_type, s.frequency, s.amount_cents,
           s.next_due_date, s.grace_days,
           o.order_code, c.name AS customer_name, c.phone_primary
    FROM recurring_schedules s
    JOIN orders o ON o.id = s.order_id
    JOIN customers c ON c.id = o.customer_id
    WHERE s.status = 'active' AND s.next_due_date <= $1
    ORDER BY s.next_due_date ASC
  `;

  try {
    // Get all overdue schedules
    const { rows: schedules } = await pool.query(sql, [dueBefore]);

    const today = new Date(dueBefore + "T00:00:00Z");
    const overdueRecords = [];

    // Loop through each overdue schedule
    for (const schedule of schedules) {
      const cycleStart = new Date(new Date(schedule.next_due_date).getTime() - (schedule.frequency === "weekly" ? 7 : 30) * 86400000);

      const pays = await pool.query(
        `SELECT COALESCE(SUM(amount_cents),0) AS paid
         FROM transactions
         WHERE order_id=$1 AND type IN ('payment','deposit')
           AND paid_at BETWEEN $2 AND ($3::date + interval '1 day')`,
        [schedule.order_id, cycleStart, dueBefore]
      );

      const paid = Number(pays.rows[0].paid || 0);
      const due = Number(schedule.amount_cents);
      const outstanding = Math.max(due - paid, 0);

      const daysLate = Math.floor((+today - +new Date(schedule.next_due_date)) / 86400000) - Number(schedule.grace_days || 0);
      let bucket = "current";
      if (daysLate > 0 && daysLate <= 7) bucket = "1-7";
      else if (daysLate >= 8 && daysLate <= 30) bucket = "8-30";
      else if (daysLate > 30) bucket = ">30";

      if (outstanding > 0) {
        overdueRecords.push({
          order_id: schedule.order_id,
          order_code: schedule.order_code,
          schedule_id: schedule.schedule_id,
          schedule_type: schedule.schedule_type,
          frequency: schedule.frequency,
          amount_myr: due / 100,
          outstanding_myr: outstanding / 100,
          customer_name: schedule.customer_name,
          phone: schedule.phone_primary,
          due_date: schedule.next_due_date,
          days_late: Math.max(daysLate, 0),
          bucket
        });
      }
    }

    // Display overdue records
    console.log("Overdue Payments:");
    console.table(overdueRecords);

    // Optional: Implement notifications (e.g., send email, or store result in database)

  } catch (e) {
    console.error("Error running Chase List:", e.message);
  } finally {
    await pool.end();
  }
}

// Run the chase list manually
runChaseList();
