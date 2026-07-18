// Postgres-backed database (tested against Neon's free tier, but any standard
// Postgres connection string works). All route code in server.js is unchanged
// except for adding `await` — this file is still the only thing that knows
// how data is actually stored.

import pg from "pg";

const { Pool } = pg;
const { DATABASE_URL } = process.env;

if (!DATABASE_URL) {
  console.error("Missing DATABASE_URL in .env — see .env.example. Free Postgres: https://neon.tech");
  process.exit(1);
}

export const pool = new Pool({
  connectionString: DATABASE_URL,
  // Neon (and most hosted Postgres free tiers) require SSL but use a cert
  // chain Node doesn't automatically trust — this is the standard workaround.
  ssl: DATABASE_URL.includes("localhost") ? false : { rejectUnauthorized: false },
});

async function init() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS students (
      id TEXT PRIMARY KEY,
      seq BIGSERIAL,
      name TEXT NOT NULL,
      cls TEXT,
      school TEXT NOT NULL,
      phone TEXT DEFAULT '',
      total NUMERIC NOT NULL DEFAULT 0,
      paid NUMERIC NOT NULL DEFAULT 0,
      due TEXT,
      plan_type TEXT DEFAULT 'full',
      frequency TEXT,
      installment_amount NUMERIC,
      installments JSONB DEFAULT '[]'::jsonb,
      payments JSONB DEFAULT '[]'::jsonb,
      history JSONB DEFAULT '[]'::jsonb,
      created_at TIMESTAMPTZ DEFAULT now()
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS reminders (
      id TEXT PRIMARY KEY,
      seq BIGSERIAL,
      student_id TEXT,
      name TEXT,
      school TEXT,
      phone TEXT,
      balance NUMERIC,
      message TEXT,
      sent_at TIMESTAMPTZ DEFAULT now(),
      sent_by TEXT
    );
  `);
}

// Every exported function awaits this first, so the very first request after a
// cold start (or the very first request ever, before tables exist) just works.
const ready = init().catch((err) => {
  console.error("Failed to initialize database schema:", err.message);
  process.exit(1);
});

function toStudent(row) {
  return {
    id: row.id,
    name: row.name,
    cls: row.cls,
    school: row.school,
    phone: row.phone || "",
    total: Number(row.total),
    paid: Number(row.paid),
    due: row.due,
    planType: row.plan_type || "full",
    frequency: row.frequency || null,
    installmentAmount: row.installment_amount != null ? Number(row.installment_amount) : undefined,
    installments: row.installments || [],
    payments: row.payments || [],
    history: row.history || [],
  };
}

function toReminder(row) {
  return {
    id: row.id,
    studentId: row.student_id,
    name: row.name,
    school: row.school,
    phone: row.phone,
    balance: row.balance != null ? Number(row.balance) : undefined,
    message: row.message,
    sentAt: row.sent_at instanceof Date ? row.sent_at.toISOString() : row.sent_at,
    sentBy: row.sent_by,
  };
}

export const db = {
  async getStudents() {
    await ready;
    const { rows } = await pool.query("SELECT * FROM students ORDER BY seq DESC");
    return rows.map(toStudent);
  },

  async addStudent(student) {
    await ready;
    const { rows } = await pool.query(
      `INSERT INTO students (id, name, cls, school, phone, total, paid, due, plan_type, frequency, installment_amount, installments, payments, history)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       RETURNING *`,
      [
        student.id, student.name, student.cls, student.school, student.phone || "",
        student.total, student.paid || 0, student.due,
        student.planType || "full", student.frequency || null,
        student.installmentAmount ?? null,
        JSON.stringify(student.installments || []),
        JSON.stringify(student.payments || []),
        JSON.stringify(student.history || []),
      ]
    );
    return toStudent(rows[0]);
  },

  async bulkAddStudents(students) {
    await ready;
    const created = [];
    // Sequential inserts on one connection — plenty fast for the batch sizes a
    // real school import has (tens to low hundreds of rows), and much simpler
    // than a multi-row VALUES statement for jsonb columns.
    for (const student of students) {
      created.push(await db.addStudent(student));
    }
    return created;
  },

  async updateStudent(id, patch) {
    await ready;
    const fieldMap = {
      name: "name", cls: "cls", school: "school", phone: "phone",
      total: "total", paid: "paid", due: "due",
      planType: "plan_type", frequency: "frequency", installmentAmount: "installment_amount",
      installments: "installments", payments: "payments", history: "history",
    };
    const jsonFields = new Set(["installments", "payments", "history"]);
    const sets = [];
    const values = [];
    let i = 1;
    for (const [key, col] of Object.entries(fieldMap)) {
      if (key in patch) {
        sets.push(`${col} = $${i}`);
        values.push(jsonFields.has(key) ? JSON.stringify(patch[key]) : patch[key]);
        i++;
      }
    }
    if (!sets.length) {
      const { rows } = await pool.query("SELECT * FROM students WHERE id = $1", [id]);
      return rows[0] ? toStudent(rows[0]) : null;
    }
    values.push(id);
    const { rows } = await pool.query(`UPDATE students SET ${sets.join(", ")} WHERE id = $${i} RETURNING *`, values);
    return rows[0] ? toStudent(rows[0]) : null;
  },

  async addPayment(id, amount) {
    await ready;
    const { rows } = await pool.query("SELECT * FROM students WHERE id = $1", [id]);
    if (!rows[0]) return null;
    const s = toStudent(rows[0]);
    const newPaid = Math.min(s.total, s.paid + amount);
    const newPayments = [...(s.payments || []), { amount, date: new Date().toISOString() }];
    const { rows: updated } = await pool.query(
      "UPDATE students SET paid = $1, payments = $2 WHERE id = $3 RETURNING *",
      [newPaid, JSON.stringify(newPayments), id]
    );
    return toStudent(updated[0]);
  },

  async deleteStudent(id) {
    await ready;
    await pool.query("DELETE FROM students WHERE id = $1", [id]);
  },

  async getReminders() {
    await ready;
    const { rows } = await pool.query("SELECT * FROM reminders ORDER BY seq DESC");
    return rows.map(toReminder);
  },

  async addReminder(reminder) {
    await ready;
    const { rows } = await pool.query(
      `INSERT INTO reminders (id, student_id, name, school, phone, balance, message, sent_at, sent_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [reminder.id, reminder.studentId, reminder.name, reminder.school, reminder.phone, reminder.balance ?? null, reminder.message, reminder.sentAt, reminder.sentBy]
    );
    return toReminder(rows[0]);
  },

  async exportAll() {
    await ready;
    const students = await db.getStudents();
    const reminders = await db.getReminders();
    return { students, reminders };
  },

  async importAll({ students, reminders }) {
    await ready;
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("DELETE FROM students");
      await client.query("DELETE FROM reminders");
      for (const s of students) {
        await client.query(
          `INSERT INTO students (id, name, cls, school, phone, total, paid, due, plan_type, frequency, installment_amount, installments, payments, history)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
          [
            s.id, s.name, s.cls, s.school, s.phone || "", s.total, s.paid || 0, s.due,
            s.planType || "full", s.frequency || null, s.installmentAmount ?? null,
            JSON.stringify(s.installments || []), JSON.stringify(s.payments || []), JSON.stringify(s.history || []),
          ]
        );
      }
      for (const r of reminders) {
        await client.query(
          `INSERT INTO reminders (id, student_id, name, school, phone, balance, message, sent_at, sent_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [r.id, r.studentId, r.name, r.school, r.phone, r.balance ?? null, r.message, r.sentAt, r.sentBy]
        );
      }
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  },
};
