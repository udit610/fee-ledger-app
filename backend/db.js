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
  // Safety valves against a hung request holding a row lock (from the FOR UPDATE
  // transactions below) forever. If a query somehow stalls (network blip, a bug),
  // Postgres kills it after 10s instead of leaving other edits to that same
  // student blocked indefinitely.
  statement_timeout: 10_000,
  query_timeout: 10_000,
  idle_in_transaction_session_timeout: 10_000,
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
  await pool.query(`
    CREATE TABLE IF NOT EXISTS expenses (
      id TEXT PRIMARY KEY,
      seq BIGSERIAL,
      school TEXT NOT NULL,
      category TEXT,
      description TEXT,
      vendor TEXT,
      amount NUMERIC NOT NULL DEFAULT 0,
      date TEXT,
      history JSONB DEFAULT '[]'::jsonb,
      created_at TIMESTAMPTZ DEFAULT now()
    );
  `);
  // Automatic point-in-time snapshots of the whole database — a safety net that
  // doesn't depend on anyone remembering to click "Backup". Taken once a day
  // opportunistically, and always right before a restore overwrites anything.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS backups (
      id SERIAL PRIMARY KEY,
      taken_at TIMESTAMPTZ DEFAULT now(),
      reason TEXT,
      student_count INT,
      data JSONB
    );
  `);
}

// Every exported function awaits this first, so the very first request after a
// cold start (or the very first request ever, before tables exist) just works.
const ready = init().catch((err) => {
  console.error("Failed to initialize database schema:", err.message);
  process.exit(1);
});

// Used in the catch/early-return branches of the FOR UPDATE transactions below.
// If the session was already killed (e.g. by idle_in_transaction_session_timeout
// above), the ROLLBACK call itself would throw — swallowed here so callers see
// the real underlying problem instead of a confusing secondary error.
async function safeRollback(client) {
  try {
    await client.query("ROLLBACK");
  } catch {
    // session likely already gone (e.g. timed out) — nothing more to do
  }
}

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

function toExpense(row) {
  return {
    id: row.id,
    school: row.school,
    category: row.category || "Miscellaneous",
    description: row.description || "",
    vendor: row.vendor || "",
    amount: Number(row.amount),
    date: row.date,
    history: row.history || [],
  };
}

// Mirrors the same pure logic the frontend uses to build a schedule (see App.jsx),
// duplicated here so regenerateSchedule can run entirely server-side rather than
// trusting a client-computed installments array.
const FREQ_CONFIG = {
  monthly: { count: 12, monthsApart: 1, label: "Month" },
  quarterly: { count: 4, monthsApart: 3, label: "Quarter" },
  biannual: { count: 2, monthsApart: 6, label: "Half" },
};

function addMonths(dateStr, n) {
  const d = new Date(dateStr + "T00:00:00");
  const day = d.getDate();
  d.setMonth(d.getMonth() + n);
  if (d.getDate() < day) d.setDate(0); // guard against month-length overflow (e.g. Jan 31 + 1mo)
  return d.toISOString().slice(0, 10);
}

function generateInstallments(frequency, startDue, amount) {
  const cfg = FREQ_CONFIG[frequency] || FREQ_CONFIG.monthly;
  const amt = Number(amount) || 0;
  return Array.from({ length: cfg.count }, (_, i) => ({
    period: `${cfg.label} ${i + 1}`,
    due: addMonths(startDue, i * cfg.monthsApart),
    amount: amt,
    paid: false,
    paidDate: null,
  }));
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
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      // FOR UPDATE locks this row until COMMIT/ROLLBACK — if a second payment for the
      // SAME student comes in at the same moment, it simply waits its turn instead of
      // racing and silently overwriting this one.
      const { rows } = await client.query("SELECT * FROM students WHERE id = $1 FOR UPDATE", [id]);
      if (!rows[0]) {
        await safeRollback(client);
        return null;
      }
      const s = toStudent(rows[0]);
      const newPaid = Math.min(s.total, s.paid + amount);
      const newPayments = [...(s.payments || []), { amount, date: new Date().toISOString() }];
      const { rows: updated } = await client.query(
        "UPDATE students SET paid = $1, payments = $2 WHERE id = $3 RETURNING *",
        [newPaid, JSON.stringify(newPayments), id]
      );
      await client.query("COMMIT");
      return toStudent(updated[0]);
    } catch (err) {
      await safeRollback(client);
      throw err;
    } finally {
      client.release();
    }
  },

  // Marks exactly one installment paid on the server, inside a locked transaction.
  // This is the fix for the "two people editing at once" lost-update risk: the
  // frontend no longer computes and sends back the WHOLE installments array (which
  // could be based on stale data) — it just says "mark this one period paid" and the
  // database does the read-modify-write atomically, so concurrent marks can't clobber
  // each other no matter how close together they happen.
  async markInstallmentPaid(id, period) {
    await ready;
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const { rows } = await client.query("SELECT * FROM students WHERE id = $1 FOR UPDATE", [id]);
      if (!rows[0]) {
        await safeRollback(client);
        return { error: "not_found" };
      }
      const s = toStudent(rows[0]);
      const inst = (s.installments || []).find((i) => i.period === period);
      if (!inst) {
        await safeRollback(client);
        return { error: "period_not_found" };
      }
      if (inst.paid) {
        await safeRollback(client);
        return { student: s, alreadyPaid: true };
      }
      const installments = s.installments.map((i) =>
        i.period === period ? { ...i, paid: true, paidDate: new Date().toISOString() } : i
      );
      const paid = installments.filter((i) => i.paid).reduce((a, i) => a + Number(i.amount || 0), 0);
      const payments = [...(s.payments || []), { amount: inst.amount, date: new Date().toISOString(), note: inst.period }];
      const { rows: updated } = await client.query(
        "UPDATE students SET installments = $1, paid = $2, payments = $3 WHERE id = $4 RETURNING *",
        [JSON.stringify(installments), paid, JSON.stringify(payments), id]
      );
      await client.query("COMMIT");
      return { student: toStudent(updated[0]) };
    } catch (err) {
      await safeRollback(client);
      throw err;
    } finally {
      client.release();
    }
  },

  // Rebuilds an installment-plan student's schedule from scratch, entirely
  // server-side and inside the same FOR UPDATE lock pattern as above. The
  // frontend used to compute the new installments array itself and PUT the
  // whole thing back — same lost-update risk as markInstallmentPaid had, just
  // rarer in practice since it's gated behind an explicit confirm dialog.
  async regenerateSchedule(id) {
    await ready;
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const { rows } = await client.query("SELECT * FROM students WHERE id = $1 FOR UPDATE", [id]);
      if (!rows[0]) {
        await safeRollback(client);
        return { error: "not_found" };
      }
      const s = toStudent(rows[0]);
      if (s.planType !== "monthly" && s.planType !== "quarterly") {
        await safeRollback(client);
        return { error: "not_installment_plan" };
      }
      const startDue = (s.installments && s.installments[0] && s.installments[0].due) || s.due;
      const installments = generateInstallments(s.frequency, startDue, s.installmentAmount);
      const total = installments.reduce((a, i) => a + Number(i.amount || 0), 0);
      const { rows: updated } = await client.query(
        "UPDATE students SET installments = $1, total = $2, paid = 0 WHERE id = $3 RETURNING *",
        [JSON.stringify(installments), total, id]
      );
      await client.query("COMMIT");
      return { student: toStudent(updated[0]) };
    } catch (err) {
      await safeRollback(client);
      throw err;
    } finally {
      client.release();
    }
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

  // ---------- Expenses ----------

  async getExpenses() {
    await ready;
    const { rows } = await pool.query("SELECT * FROM expenses ORDER BY seq DESC");
    return rows.map(toExpense);
  },

  async addExpense(expense) {
    await ready;
    const { rows } = await pool.query(
      `INSERT INTO expenses (id, school, category, description, vendor, amount, date, history)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [
        expense.id, expense.school, expense.category || "Miscellaneous", expense.description || "",
        expense.vendor || "", Number(expense.amount) || 0, expense.date,
        JSON.stringify(expense.history || []),
      ]
    );
    return toExpense(rows[0]);
  },

  async updateExpense(id, patch) {
    await ready;
    const fieldMap = { school: "school", category: "category", description: "description", vendor: "vendor", amount: "amount", date: "date", history: "history" };
    const jsonFields = new Set(["history"]);
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
      const { rows } = await pool.query("SELECT * FROM expenses WHERE id = $1", [id]);
      return rows[0] ? toExpense(rows[0]) : null;
    }
    values.push(id);
    const { rows } = await pool.query(`UPDATE expenses SET ${sets.join(", ")} WHERE id = $${i} RETURNING *`, values);
    return rows[0] ? toExpense(rows[0]) : null;
  },

  async deleteExpense(id) {
    await ready;
    await pool.query("DELETE FROM expenses WHERE id = $1", [id]);
  },

  async exportAll() {
    await ready;
    const students = await db.getStudents();
    const reminders = await db.getReminders();
    const expenses = await db.getExpenses();
    return { students, reminders, expenses };
  },

  // Saves a full point-in-time copy into the backups table. Cheap: this app's
  // entire dataset (a few hundred students at most) is tiny by database standards.
  async snapshot(reason) {
    await ready;
    const data = await db.exportAll();
    await pool.query("INSERT INTO backups (reason, student_count, data) VALUES ($1, $2, $3)", [
      reason,
      data.students.length,
      JSON.stringify(data),
    ]);
    // Keep only the most recent 60 snapshots so this table can't grow unbounded.
    await pool.query(`
      DELETE FROM backups WHERE id NOT IN (SELECT id FROM backups ORDER BY taken_at DESC LIMIT 60)
    `);
  },

  // Called opportunistically on normal page-load traffic — takes one automatic
  // snapshot per calendar day without needing a separate cron service.
  async ensureDailySnapshot() {
    await ready;
    const { rows } = await pool.query(
      "SELECT 1 FROM backups WHERE reason = 'daily' AND taken_at::date = now()::date LIMIT 1"
    );
    if (rows.length === 0) await db.snapshot("daily");
  },

  async listSnapshots() {
    await ready;
    const { rows } = await pool.query(
      "SELECT id, taken_at, reason, student_count FROM backups ORDER BY taken_at DESC"
    );
    return rows;
  },

  async getSnapshot(id) {
    await ready;
    const { rows } = await pool.query("SELECT * FROM backups WHERE id = $1", [id]);
    return rows[0] ? rows[0].data : null;
  },

  async importAll({ students, reminders, expenses = [] }) {
    await ready;
    // Always snapshot the CURRENT state right before overwriting it, regardless of
    // whether the incoming data turns out to be good — this is the undo button for
    // "someone restored the wrong file by mistake".
    await db.snapshot("pre-restore");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("DELETE FROM students");
      await client.query("DELETE FROM reminders");
      await client.query("DELETE FROM expenses");
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
      for (const e of expenses) {
        await client.query(
          `INSERT INTO expenses (id, school, category, description, vendor, amount, date, history)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [e.id, e.school, e.category || "Miscellaneous", e.description || "", e.vendor || "", Number(e.amount) || 0, e.date, JSON.stringify(e.history || [])]
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
