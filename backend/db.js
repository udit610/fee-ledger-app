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
      father_name TEXT DEFAULT '',
      total NUMERIC NOT NULL DEFAULT 0,
      paid NUMERIC NOT NULL DEFAULT 0,
      due TEXT,
      plan_type TEXT DEFAULT 'full',
      frequency TEXT,
      installment_amount NUMERIC,
      installments JSONB DEFAULT '[]'::jsonb,
      payments JSONB DEFAULT '[]'::jsonb,
      history JSONB DEFAULT '[]'::jsonb,
      transport_rate NUMERIC DEFAULT 0,
      transport_months JSONB DEFAULT '[]'::jsonb,
      transport_paid NUMERIC NOT NULL DEFAULT 0,
      transport_payments JSONB DEFAULT '[]'::jsonb,
      annual_fee_amount NUMERIC DEFAULT 0,
      annual_fee_paid NUMERIC NOT NULL DEFAULT 0,
      annual_fee_payments JSONB DEFAULT '[]'::jsonb,
      session_year INTEGER,
      previous_session_due NUMERIC NOT NULL DEFAULT 0,
      previous_session_payments JSONB DEFAULT '[]'::jsonb,
      created_at TIMESTAMPTZ DEFAULT now()
    );
  `);
  // Existing databases created before this column existed won't get it from
  // CREATE TABLE IF NOT EXISTS above (that only runs against a table that
  // doesn't exist yet) — add it explicitly, idempotently, for those.
  await pool.query(`ALTER TABLE students ADD COLUMN IF NOT EXISTS father_name TEXT DEFAULT '';`);
  await pool.query(`ALTER TABLE students ADD COLUMN IF NOT EXISTS transport_rate NUMERIC DEFAULT 0;`);
  await pool.query(`ALTER TABLE students ADD COLUMN IF NOT EXISTS transport_months JSONB DEFAULT '[]'::jsonb;`);
  await pool.query(`ALTER TABLE students ADD COLUMN IF NOT EXISTS transport_paid NUMERIC NOT NULL DEFAULT 0;`);
  await pool.query(`ALTER TABLE students ADD COLUMN IF NOT EXISTS transport_payments JSONB DEFAULT '[]'::jsonb;`);
  await pool.query(`ALTER TABLE students ADD COLUMN IF NOT EXISTS previous_session_due NUMERIC NOT NULL DEFAULT 0;`);
  await pool.query(`ALTER TABLE students ADD COLUMN IF NOT EXISTS previous_session_payments JSONB DEFAULT '[]'::jsonb;`);
  await pool.query(`ALTER TABLE students ADD COLUMN IF NOT EXISTS annual_fee_amount NUMERIC DEFAULT 0;`);
  await pool.query(`ALTER TABLE students ADD COLUMN IF NOT EXISTS annual_fee_paid NUMERIC NOT NULL DEFAULT 0;`);
  await pool.query(`ALTER TABLE students ADD COLUMN IF NOT EXISTS annual_fee_payments JSONB DEFAULT '[]'::jsonb;`);
  // session_year needs special care: on a brand-new table it's fine to leave it
  // NULL (addStudent always sets it going forward). But on an EXISTING database,
  // adding this column with no value would make every existing student look like
  // they're behind on their session the moment this ships, rolling everyone's
  // real balances into "previous session due" on the next request. Backfilling
  // it to the CURRENT academic year for anyone who doesn't have one yet avoids that.
  await pool.query(`ALTER TABLE students ADD COLUMN IF NOT EXISTS session_year INTEGER;`);
  await pool.query(`UPDATE students SET session_year = $1 WHERE session_year IS NULL;`, [currentAcademicYearStart()]);
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
    fatherName: row.father_name || "",
    total: Number(row.total),
    paid: Number(row.paid),
    due: row.due,
    planType: row.plan_type || "full",
    frequency: row.frequency || null,
    installmentAmount: row.installment_amount != null ? Number(row.installment_amount) : undefined,
    installments: row.installments || [],
    payments: row.payments || [],
    history: row.history || [],
    transportRate: Number(row.transport_rate) || 0,
    transportMonths: row.transport_months || [],
    transportPaid: Number(row.transport_paid) || 0,
    transportPayments: row.transport_payments || [],
    annualFeeAmount: Number(row.annual_fee_amount) || 0,
    annualFeePaid: Number(row.annual_fee_paid) || 0,
    annualFeePayments: row.annual_fee_payments || [],
    sessionYear: row.session_year,
    previousSessionDue: Number(row.previous_session_due) || 0,
    previousSessionPayments: row.previous_session_payments || [],
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

// The academic year this exact moment falls into, expressed as its START year
// (e.g. April 2026 through March 2027 is academic year 2026). Used both for the
// installment-schedule anchoring below and for session rollover further down.
function currentAcademicYearStart() {
  const now = new Date();
  return now.getMonth() + 1 >= 4 ? now.getFullYear() : now.getFullYear() - 1;
}

// The school's academic year runs April to March — see matching comment in App.jsx.
const ACADEMIC_MONTHS = {
  quarterly: [4, 7, 10, 1],
  biannual: [4, 10],
  monthly: [4, 5, 6, 7, 8, 9, 10, 11, 12, 1, 2, 3],
};

function academicYearAnchorDue(startDue, monthNum) {
  const d = new Date(startDue + "T00:00:00");
  const day = d.getDate();
  const startMonth = d.getMonth() + 1;
  const academicYearStart = startMonth >= 4 ? d.getFullYear() : d.getFullYear() - 1;
  const targetYear = monthNum < 4 ? academicYearStart + 1 : academicYearStart;
  const daysInTargetMonth = new Date(targetYear, monthNum, 0).getDate();
  const mm = String(monthNum).padStart(2, "0");
  const dd = String(Math.min(day, daysInTargetMonth)).padStart(2, "0");
  return `${targetYear}-${mm}-${dd}`;
}

function addMonths(dateStr, n) {
  const d = new Date(dateStr + "T00:00:00");
  const day = d.getDate();
  let targetMonth = d.getMonth() + n;
  let targetYear = d.getFullYear() + Math.floor(targetMonth / 12);
  targetMonth = ((targetMonth % 12) + 12) % 12;
  const daysInTargetMonth = new Date(targetYear, targetMonth + 1, 0).getDate();
  const clampedDay = Math.min(day, daysInTargetMonth); // guard against month-length overflow (e.g. Jan 31 + 1mo)
  return `${targetYear}-${String(targetMonth + 1).padStart(2, "0")}-${String(clampedDay).padStart(2, "0")}`;
}

// "2026-06-18" -> "June 2026" — mirrors the frontend's monthYearLabel (App.jsx).
function monthYearLabel(dateStr) {
  const d = new Date(dateStr + "T00:00:00");
  return d.toLocaleDateString("en-US", { month: "long", year: "numeric" });
}

function generateInstallments(frequency, startDue, amount) {
  const cfg = FREQ_CONFIG[frequency] || FREQ_CONFIG.monthly;
  const academicMonths = ACADEMIC_MONTHS[frequency];
  const amt = Number(amount) || 0;
  return Array.from({ length: cfg.count }, (_, i) => {
    const due = academicMonths ? academicYearAnchorDue(startDue, academicMonths[i]) : addMonths(startDue, i * cfg.monthsApart);
    const period = cfg === FREQ_CONFIG.monthly ? monthYearLabel(due) : `${cfg.label} ${i + 1} · ${monthYearLabel(due)}`;
    return { period, due, amount: amt, paid: false, paidDate: null };
  });
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
      `INSERT INTO students (id, name, cls, school, phone, father_name, total, paid, due, plan_type, frequency, installment_amount, installments, payments, history, transport_rate, transport_months, transport_paid, transport_payments, session_year, previous_session_due, previous_session_payments, annual_fee_amount, annual_fee_paid, annual_fee_payments)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25)
       RETURNING *`,
      [
        student.id, student.name, student.cls, student.school, student.phone || "", student.fatherName || "",
        student.total, student.paid || 0, student.due,
        student.planType || "full", student.frequency || null,
        student.installmentAmount ?? null,
        JSON.stringify(student.installments || []),
        JSON.stringify(student.payments || []),
        JSON.stringify(student.history || []),
        student.transportRate || 0,
        JSON.stringify(student.transportMonths || []),
        student.transportPaid || 0,
        JSON.stringify(student.transportPayments || []),
        student.sessionYear ?? currentAcademicYearStart(),
        student.previousSessionDue || 0,
        JSON.stringify(student.previousSessionPayments || []),
        student.annualFeeAmount || 0,
        student.annualFeePaid || 0,
        JSON.stringify(student.annualFeePayments || []),
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
      name: "name", cls: "cls", school: "school", phone: "phone", fatherName: "father_name",
      total: "total", paid: "paid", due: "due",
      planType: "plan_type", frequency: "frequency", installmentAmount: "installment_amount",
      installments: "installments", payments: "payments", history: "history",
      transportRate: "transport_rate",
      annualFeeAmount: "annual_fee_amount",
      previousSessionDue: "previous_session_due",
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

  async addPayment(id, amount, method = "cash", by = "") {
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
      const newPayments = [...(s.payments || []), { amount, date: new Date().toISOString(), method, by }];
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

  // Records a payment against previous_session_due — a separate ledger from the
  // current session's paid/total, same as transport. Staff choose which balance a
  // payment applies to by which icon/panel they open, rather than picking a target
  // inside one shared form.
  async addPreviousSessionPayment(id, amount, method = "cash", by = "") {
    await ready;
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const { rows } = await client.query("SELECT * FROM students WHERE id = $1 FOR UPDATE", [id]);
      if (!rows[0]) {
        await safeRollback(client);
        return null;
      }
      const s = toStudent(rows[0]);
      const newDue = Math.max(0, (s.previousSessionDue || 0) - amount);
      const newPayments = [...(s.previousSessionPayments || []), { amount, date: new Date().toISOString(), method, by }];
      const { rows: updated } = await client.query(
        "UPDATE students SET previous_session_due = $1, previous_session_payments = $2 WHERE id = $3 RETURNING *",
        [newDue, JSON.stringify(newPayments), id]
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

  // Toggles a single academic-year month ("2026-04") on/off in a student's transport
  // opt-in list. Row-locked like addPayment — if the same student's transport is being
  // toggled by two people at once, the second one waits instead of clobbering the first.
  // isCollector: when true, this call can only ADD a month, never remove one that's
  // already opted in — enforced here (not just in the UI) so a collector account can't
  // just call the API directly to bypass it. The route in server.js passes this based
  // on req.user.role.
  async toggleTransportMonth(id, monthKey, enabled, isCollector = false) {
    await ready;
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const { rows } = await client.query("SELECT * FROM students WHERE id = $1 FOR UPDATE", [id]);
      if (!rows[0]) {
        await safeRollback(client);
        return null;
      }
      const s = toStudent(rows[0]);
      const current = new Set(s.transportMonths || []);
      if (isCollector && !enabled && current.has(monthKey)) {
        await safeRollback(client);
        return { error: "collector_cannot_remove" };
      }
      if (enabled) current.add(monthKey);
      else current.delete(monthKey);
      const newMonths = Array.from(current).sort();
      const { rows: updated } = await client.query(
        "UPDATE students SET transport_months = $1 WHERE id = $2 RETURNING *",
        [JSON.stringify(newMonths), id]
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

  // Records a transport payment. Same shape/logic as addPayment, but against the
  // separate transport_paid/transport_payments columns — transport is tracked as its
  // own balance, entirely independent of the student's tuition total/paid.
  async addTransportPayment(id, amount, method = "cash", by = "") {
    await ready;
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const { rows } = await client.query("SELECT * FROM students WHERE id = $1 FOR UPDATE", [id]);
      if (!rows[0]) {
        await safeRollback(client);
        return null;
      }
      const s = toStudent(rows[0]);
      const transportTotal = (s.transportMonths || []).length * (s.transportRate || 0);
      const newPaid = Math.min(transportTotal, (s.transportPaid || 0) + amount);
      const newPayments = [...(s.transportPayments || []), { amount, date: new Date().toISOString(), method, by }];
      const { rows: updated } = await client.query(
        "UPDATE students SET transport_paid = $1, transport_payments = $2 WHERE id = $3 RETURNING *",
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

  // Full reset of a student's transport ledger — clears every opted-in month, the
  // paid total, and the payment log. Admin-only (enforced in server.js), same
  // destructive-reset pattern as the tuition "Regenerate schedule
