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
      join_month INTEGER,
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
  // NULL means "no restriction" — the student's monthly/quarterly schedule runs
  // the full academic year (April start), exactly as it always has. Only set
  // when a student joins mid-year and should be billed starting from that month.
  await pool.query(`ALTER TABLE students ADD COLUMN IF NOT EXISTS join_month INTEGER;`);
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
    joinMonth: row.join_month != null ? Number(row.join_month) : null,
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

// Backward-compatible read of how much has actually been paid toward one
// installment — older rows only ever had a boolean `paid`, never a running
// `paidAmount`, so fall back to treating a fully-paid old installment as
// paidAmount === amount.
function instPaidAmount(inst) {
  if (inst.paidAmount != null) return Number(inst.paidAmount) || 0;
  return inst.paid ? Number(inst.amount) || 0 : 0;
}

// Position of a calendar month (1-12) within the April-start academic year:
// April -> 1, ... December -> 9, January -> 10, ... March -> 12.
function academicPosition(monthNum) {
  return monthNum >= 4 ? monthNum - 3 : monthNum + 9;
}

// Drops any academic-year term that falls before joinMonth (e.g. joinMonth=8
// keeps [8,9,10,11,12,1,2,3] out of the full monthly list) — this is how a
// mid-year joiner ends up billed for fewer months instead of all 12. A falsy
// joinMonth (the common case — student was there from the start of the
// session) returns the full list unchanged, so existing behavior is unaffected.
function filterMonthsFromJoin(months, joinMonth) {
  if (!joinMonth) return months;
  const startPos = academicPosition(joinMonth);
  return months.filter((m) => academicPosition(m) >= startPos);
}

function generateInstallments(frequency, startDue, amount, joinMonth) {
  const cfg = FREQ_CONFIG[frequency] || FREQ_CONFIG.monthly;
  const allMonths = ACADEMIC_MONTHS[frequency];
  const amt = Number(amount) || 0;
  if (allMonths) {
    const months = filterMonthsFromJoin(allMonths, joinMonth);
    return months.map((m, i) => {
      const due = academicYearAnchorDue(startDue, m);
      const period = cfg === FREQ_CONFIG.monthly ? monthYearLabel(due) : `${cfg.label} ${i + 1} · ${monthYearLabel(due)}`;
      return { period, due, amount: amt, paid: false, paidDate: null, paidAmount: 0 };
    });
  }
  return Array.from({ length: cfg.count }, (_, i) => {
    const due = addMonths(startDue, i * cfg.monthsApart);
    const period = `${cfg.label} ${i + 1} · ${monthYearLabel(due)}`;
    return { period, due, amount: amt, paid: false, paidDate: null, paidAmount: 0 };
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
      `INSERT INTO students (id, name, cls, school, phone, father_name, total, paid, due, plan_type, frequency, installment_amount, installments, payments, history, transport_rate, transport_months, transport_paid, transport_payments, session_year, previous_session_due, previous_session_payments, annual_fee_amount, annual_fee_paid, annual_fee_payments, join_month)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26)
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
        student.joinMonth || null,
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
      joinMonth: "join_month",
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
  // destructive-reset pattern as the tuition "Regenerate schedule" button.
  async resetTransport(id) {
    await ready;
    const { rows } = await pool.query(
      "UPDATE students SET transport_months = '[]', transport_paid = 0, transport_payments = '[]' WHERE id = $1 RETURNING *",
      [id]
    );
    return rows[0] ? toStudent(rows[0]) : null;
  },

  // Records an Annual Fee payment. Same shape/logic as addTransportPayment, but the
  // Annual Fee is a single once-per-academic-year charge (not months × rate) — the
  // ceiling here is just annualFeeAmount itself, not a computed transport-style total.
  async addAnnualFeePayment(id, amount, method = "cash", by = "") {
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
      const newPaid = Math.min(s.annualFeeAmount || 0, (s.annualFeePaid || 0) + amount);
      const newPayments = [...(s.annualFeePayments || []), { amount, date: new Date().toISOString(), method, by }];
      const { rows: updated } = await client.query(
        "UPDATE students SET annual_fee_paid = $1, annual_fee_payments = $2 WHERE id = $3 RETURNING *",
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

  // Full reset of a student's Annual Fee ledger — admin-only, same destructive-reset
  // pattern as resetTransport above.
  async resetAnnualFee(id) {
    await ready;
    const { rows } = await pool.query(
      "UPDATE students SET annual_fee_paid = 0, annual_fee_payments = '[]' WHERE id = $1 RETURNING *",
      [id]
    );
    return rows[0] ? toStudent(rows[0]) : null;
  },

  // Marks exactly one installment paid on the server, inside a locked transaction.
  // This is the fix for the "two people editing at once" lost-update risk: the
  // frontend no longer computes and sends back the WHOLE installments array (which
  // could be based on stale data) — it just says "mark this one period paid" and the
  // database does the read-modify-write atomically, so concurrent marks can't clobber
  // each other no matter how close together they happen.
  // Records a payment against one installment period. If the amount exceeds
  // what's left owing on that period, the overflow automatically rolls forward
  // and gets applied to the next unpaid period(s) in chronological order — so
  // a parent paying ₹2,000 against a ₹1,500 month correctly covers ₹500 of the
  // next month too, instead of that ₹500 having nowhere to go.
  // `amount` may be omitted, in which case it defaults to exactly what's left
  // owing on the named period — i.e. the old one-tap "mark paid" behavior.
  async recordInstallmentPayment(id, period, amount, method = "cash", by = "") {
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
      const sorted = [...(s.installments || [])].sort((a, b) => new Date(a.due) - new Date(b.due));
      const startIdx = sorted.findIndex((i) => i.period === period);
      if (startIdx === -1) {
        await safeRollback(client);
        return { error: "period_not_found" };
      }
      const startInst = sorted[startIdx];
      const startOwed = Math.max(0, Number(startInst.amount) - instPaidAmount(startInst));
      if (startOwed <= 0.005) {
        await safeRollback(client);
        return { student: s, alreadyPaid: true };
      }
      let remaining = amount != null ? Number(amount) : startOwed;
      if (!remaining || remaining <= 0) {
        await safeRollback(client);
        return { error: "invalid_amount" };
      }
      const now = new Date().toISOString();
      const paymentsLog = [];
      for (let idx = startIdx; idx < sorted.length && remaining > 0.005; idx++) {
        const inst = sorted[idx];
        const owed = Math.max(0, Number(inst.amount) - instPaidAmount(inst));
        if (owed <= 0.005) continue; // this period's already fully covered — skip to the next one
        const apply = Math.min(owed, remaining);
        inst.paidAmount = instPaidAmount(inst) + apply;
        inst.paid = inst.paidAmount >= Number(inst.amount) - 0.005;
        if (inst.paid) inst.paidDate = now;
        inst.paidBy = by;
        remaining -= apply;
        paymentsLog.push({ amount: apply, date: now, note: inst.period, method, by });
      }
      const leftoverUnapplied = Math.max(0, remaining);
      const totalPaid = sorted.reduce((a, i) => a + instPaidAmount(i), 0);
      const payments = [...(s.payments || []), ...paymentsLog];
      const { rows: updated } = await client.query(
        "UPDATE students SET installments = $1, paid = $2, payments = $3 WHERE id = $4 RETURNING *",
        [JSON.stringify(sorted), totalPaid, JSON.stringify(payments), id]
      );
      await client.query("COMMIT");
      return { student: toStudent(updated[0]), leftoverUnapplied };
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
      const startDue = s.due || (s.installments && s.installments[0] && s.installments[0].due);
      const installments = generateInstallments(s.frequency, startDue, s.installmentAmount, s.joinMonth);
      const total = installments.reduce((a, i) => a + Number(i.amount || 0), 0);
      const { rows: updated } = await client.query(
        "UPDATE students SET installments = $1, total = $2, paid = 0, payments = '[]' WHERE id = $3 RETURNING *",
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

  // Called opportunistically on normal page-load traffic, same pattern as
  // ensureDailySnapshot above — no separate cron needed. Any student whose
  // session_year is behind the CURRENT academic year (computed from the server's
  // clock, crossing over every April 1) gets rolled over automatically: whatever
  // they still owed gets added to previous_session_due (additive, in case the app
  // wasn't opened for more than one rollover in a row — unlikely, but this stays
  // correct either way), and total/paid/installments/payments reset to a blank
  // slate for the new session, ready for that year's fee to be entered/imported.
  // A one-line note is appended to history so the reset is visible in the audit
  // trail rather than looking like the balance just vanished.
  async ensureSessionRollover() {
    await ready;
    const year = currentAcademicYearStart();
    const { rows } = await pool.query("SELECT id FROM students WHERE session_year < $1", [year]);
    if (rows.length === 0) return;
    for (const { id } of rows) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const { rows: locked } = await client.query("SELECT * FROM students WHERE id = $1 FOR UPDATE", [id]);
        const s = locked[0];
        if (!s || Number(s.session_year) >= year) {
          // Already rolled over by a concurrent request, or somehow caught up — skip.
          await client.query("COMMIT");
          client.release();
          continue;
        }
        const leftover = Math.max(0, Number(s.total) - Number(s.paid));
        const newPreviousDue = Number(s.previous_session_due || 0) + leftover;
        const history = [
          ...(s.history || []),
          {
            field: "session_rollover",
            oldValue: `Session ${s.session_year}: ${s.total} total, ${s.paid} paid`,
            newValue: leftover > 0 ? `₹${leftover} carried to previous session dues` : "No balance carried over",
            by: "system",
            at: new Date().toISOString(),
          },
        ];
        await client.query(
          `UPDATE students SET session_year = $1, previous_session_due = $2, total = 0, paid = 0,
           installments = '[]', payments = '[]', history = $3 WHERE id = $4`,
          [year, newPreviousDue, JSON.stringify(history), id]
        );
        await client.query("COMMIT");
      } catch (err) {
        await safeRollback(client);
        throw err;
      } finally {
        client.release();
      }
    }
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
          `INSERT INTO students (id, name, cls, school, phone, father_name, total, paid, due, plan_type, frequency, installment_amount, installments, payments, history, transport_rate, transport_months, transport_paid, transport_payments, session_year, previous_session_due, previous_session_payments, annual_fee_amount, annual_fee_paid, annual_fee_payments)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25)`,
          [
            s.id, s.name, s.cls, s.school, s.phone || "", s.fatherName || "", s.total, s.paid || 0, s.due,
            s.planType || "full", s.frequency || null, s.installmentAmount ?? null,
            JSON.stringify(s.installments || []), JSON.stringify(s.payments || []), JSON.stringify(s.history || []),
            s.transportRate || 0, JSON.stringify(s.transportMonths || []), s.transportPaid || 0, JSON.stringify(s.transportPayments || []),
            s.sessionYear ?? currentAcademicYearStart(), s.previousSessionDue || 0, JSON.stringify(s.previousSessionPayments || []),
            s.annualFeeAmount || 0, s.annualFeePaid || 0, JSON.stringify(s.annualFeePayments || []),
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
