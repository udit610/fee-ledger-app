import "dotenv/config";
import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import jwt from "jsonwebtoken";
import { OAuth2Client } from "google-auth-library";
import { db } from "./db.js";

const {
  GOOGLE_CLIENT_ID,
  ALLOWED_EMAILS = "",
  ALLOWED_EMAIL_SCHOOLS = "",
  JWT_SECRET,
  FRONTEND_URL = "http://localhost:5173",
  PORT = 4000,
  NODE_ENV = "development",
} = process.env;

if (!GOOGLE_CLIENT_ID || !JWT_SECRET) {
  console.error("Missing GOOGLE_CLIENT_ID or JWT_SECRET in .env — see .env.example");
  process.exit(1);
}

const allowedEmails = ALLOWED_EMAILS.split(",").map((e) => e.trim().toLowerCase()).filter(Boolean);

// Optional per-email school scoping. Set ALLOWED_EMAIL_SCHOOLS to a JSON object like:
//   {"teacher1@gmail.com": ["Vardhman Convent School"], "teacher2@gmail.com": ["Blossom Heights Pre-School"]}
// Emails NOT listed here (but present in ALLOWED_EMAILS) can see ALL schools — so existing
// admin accounts keep working exactly as before with zero config changes required.
let emailSchoolMap = {};
if (ALLOWED_EMAIL_SCHOOLS) {
  try {
    const parsed = JSON.parse(ALLOWED_EMAIL_SCHOOLS);
    Object.keys(parsed).forEach((e) => (emailSchoolMap[e.trim().toLowerCase()] = parsed[e]));
  } catch {
    console.error("ALLOWED_EMAIL_SCHOOLS is set but is not valid JSON — ignoring it.");
  }
}
function schoolsFor(email) {
  return emailSchoolMap[email] || null; // null = no restriction, sees everything
}

const googleClient = new OAuth2Client(GOOGLE_CLIENT_ID);

const app = express();
app.use(express.json({ limit: "5mb" }));
app.use(cookieParser());
app.use(cors({ origin: FRONTEND_URL, credentials: true }));

const cookieOpts = {
  httpOnly: true,
  secure: NODE_ENV === "production",
  // "lax" works now because the frontend proxies /api/* through its own domain
  // (see frontend/vercel.json), so the browser sees this as a first-party,
  // same-site cookie instead of a cross-site one that gets blocked.
  sameSite: "lax",
  maxAge: 1000 * 60 * 60 * 24 * 14, // 14 days
};

// Wraps an async route handler so a thrown/rejected error becomes a 500
// instead of crashing the process or hanging the request — matters more
// now that every route touches the network (the database), not a local file.
function h(fn) {
  return (req, res) => {
    Promise.resolve(fn(req, res)).catch((err) => {
      console.error(err);
      if (!res.headersSent) res.status(500).json({ error: "Something went wrong on the server. Please try again." });
    });
  };
}

// ---------- Auth ----------

app.post("/api/auth/google", h(async (req, res) => {
  const { credential } = req.body;
  if (!credential) return res.status(400).json({ error: "Missing credential" });

  let payload;
  try {
    const ticket = await googleClient.verifyIdToken({ idToken: credential, audience: GOOGLE_CLIENT_ID });
    payload = ticket.getPayload();
  } catch (err) {
    return res.status(401).json({ error: "Invalid Google token" });
  }

  const email = (payload.email || "").toLowerCase();
  if (!payload.email_verified) return res.status(403).json({ error: "Email not verified with Google" });
  if (allowedEmails.length && !allowedEmails.includes(email)) {
    return res.status(403).json({ error: "This Google account is not authorized for this ledger" });
  }

  const user = { email, name: payload.name, picture: payload.picture, schools: schoolsFor(email) };
  const token = jwt.sign(user, JWT_SECRET, { expiresIn: "14d" });
  res.cookie("session", token, cookieOpts);
  res.json({ user });
}));

app.post("/api/auth/logout", (req, res) => {
  res.clearCookie("session", cookieOpts);
  res.json({ ok: true });
});

app.get("/api/auth/me", (req, res) => {
  const token = req.cookies.session;
  if (!token) return res.status(401).json({ error: "Not signed in" });
  try {
    const user = jwt.verify(token, JWT_SECRET);
    res.json({ user });
  } catch {
    res.status(401).json({ error: "Session expired" });
  }
});

function requireAuth(req, res, next) {
  const token = req.cookies.session;
  if (!token) return res.status(401).json({ error: "Not signed in" });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: "Session expired" });
  }
}

// Blocks a request whose `school` (or `students[].school`) falls outside the caller's allowed schools.
function assertSchoolAllowed(req, res, school) {
  const schools = req.user.schools;
  if (schools && !schools.includes(school)) {
    res.status(403).json({ error: `Not authorized for ${school}` });
    return false;
  }
  return true;
}

// ---------- Students ----------

app.get("/api/students", requireAuth, h(async (req, res) => {
  db.ensureDailySnapshot().catch((err) => console.error("Daily snapshot failed:", err.message)); // fire-and-forget, never blocks the response
  const all = await db.getStudents();
  const schools = req.user.schools;
  res.json(schools ? all.filter((s) => schools.includes(s.school)) : all);
}));

app.post("/api/students", requireAuth, h(async (req, res) => {
  const { name, cls, school, phone, total, paid, due, planType, frequency, installmentAmount, installments } = req.body;
  if (!name || !total || !due) return res.status(400).json({ error: "name, total, and due are required" });
  if (!assertSchoolAllowed(req, res, school)) return;
  const student = {
    id: "s" + Date.now() + Math.random().toString(36).slice(2, 7),
    name,
    cls: cls || "—",
    school,
    phone: phone || "",
    total: Number(total),
    paid: Number(paid) || 0,
    due,
    planType: planType || "full",
    frequency: frequency || null,
    installmentAmount: installmentAmount != null ? Number(installmentAmount) : undefined,
    installments: Array.isArray(installments) ? installments : undefined,
    payments: Number(paid) > 0 ? [{ amount: Number(paid), date: new Date().toISOString() }] : [],
    history: [{ field: "created", oldValue: null, newValue: null, by: req.user.email, at: new Date().toISOString() }],
  };
  res.status(201).json(await db.addStudent(student));
}));

app.post("/api/students/bulk-import", requireAuth, h(async (req, res) => {
  const { students } = req.body;
  if (!Array.isArray(students)) return res.status(400).json({ error: "students must be an array" });
  const schools = req.user.schools;
  const prepared = students
    .filter((r) => r.name && Number(r.total) > 0 && r.due)
    .filter((r) => !schools || schools.includes(r.school))
    .map((r) => ({
      id: "s" + Date.now() + Math.random().toString(36).slice(2, 7),
      name: r.name,
      cls: r.cls || "—",
      school: r.school,
      phone: r.phone || "",
      total: Number(r.total),
      paid: Number(r.paid) || 0,
      due: r.due,
      planType: r.planType || "full",
      frequency: r.frequency || null,
      installmentAmount: r.installmentAmount != null ? Number(r.installmentAmount) : undefined,
      installments: Array.isArray(r.installments) ? r.installments : undefined,
      payments: Number(r.paid) > 0 ? [{ amount: Number(r.paid), date: new Date().toISOString() }] : [],
      history: [{ field: "created", oldValue: null, newValue: null, by: req.user.email, at: new Date().toISOString(), note: "Excel import" }],
    }));
  res.status(201).json(await db.bulkAddStudents(prepared));
}));

// Fields worth tracking in the audit trail. Noisy/bulky fields (installments, payments) are excluded.
const AUDIT_FIELDS = ["name", "cls", "school", "phone", "total", "paid", "due", "planType", "frequency", "installmentAmount"];

app.put("/api/students/:id", requireAuth, h(async (req, res) => {
  const all = await db.getStudents();
  const existing = all.find((s) => s.id === req.params.id);
  if (!existing) return res.status(404).json({ error: "Student not found" });
  if (!assertSchoolAllowed(req, res, existing.school)) return;
  if (req.body.school && !assertSchoolAllowed(req, res, req.body.school)) return;

  const patch = { ...req.body };
  if (patch.total != null) patch.total = Number(patch.total);
  if (patch.paid != null) patch.paid = Number(patch.paid);

  const changes = [];
  const now = new Date().toISOString();
  AUDIT_FIELDS.forEach((field) => {
    if (field in patch && String(patch[field]) !== String(existing[field])) {
      changes.push({ field, oldValue: existing[field] ?? null, newValue: patch[field], by: req.user.email, at: now });
    }
  });
  if (changes.length) patch.history = [...(existing.history || []), ...changes];

  const updated = await db.updateStudent(req.params.id, patch);
  if (!updated) return res.status(404).json({ error: "Student not found" });
  res.json(updated);
}));

app.post("/api/students/:id/payments", requireAuth, h(async (req, res) => {
  const all = await db.getStudents();
  const existing = all.find((s) => s.id === req.params.id);
  if (!existing) return res.status(404).json({ error: "Student not found" });
  if (!assertSchoolAllowed(req, res, existing.school)) return;
  const amount = Number(req.body.amount);
  if (!amount || amount <= 0) return res.status(400).json({ error: "amount must be a positive number" });
  const method = req.body.method === "upi_bank" ? "upi_bank" : "cash";
  const updated = await db.addPayment(req.params.id, amount, method);
  if (!updated) return res.status(404).json({ error: "Student not found" });
  res.json(updated);
}));

// Atomic — marks exactly one installment paid without the client ever sending back
// the whole installments array, so two people acting on the same student at once
// can't silently overwrite each other's change (see db.js for the locking detail).
app.post("/api/students/:id/installments/:period/pay", requireAuth, h(async (req, res) => {
  const all = await db.getStudents();
  const existing = all.find((s) => s.id === req.params.id);
  if (!existing) return res.status(404).json({ error: "Student not found" });
  if (!assertSchoolAllowed(req, res, existing.school)) return;
  const method = req.body.method === "upi_bank" ? "upi_bank" : "cash";
  const result = await db.markInstallmentPaid(req.params.id, req.params.period, method);
  if (result.error === "not_found") return res.status(404).json({ error: "Student not found" });
  if (result.error === "period_not_found") return res.status(404).json({ error: "That installment doesn't exist on this student" });
  res.json(result.student);
}));

// Also atomic — rebuilds the schedule server-side (same lock pattern) instead of
// trusting a client-computed installments array. See db.js for details.
app.post("/api/students/:id/regenerate-schedule", requireAuth, h(async (req, res) => {
  const all = await db.getStudents();
  const existing = all.find((s) => s.id === req.params.id);
  if (!existing) return res.status(404).json({ error: "Student not found" });
  if (!assertSchoolAllowed(req, res, existing.school)) return;
  const result = await db.regenerateSchedule(req.params.id);
  if (result.error === "not_found") return res.status(404).json({ error: "Student not found" });
  if (result.error === "not_installment_plan") return res.status(400).json({ error: "This student isn't on an installment plan" });
  res.json(result.student);
}));

app.delete("/api/students/:id", requireAuth, h(async (req, res) => {
  const all = await db.getStudents();
  const existing = all.find((s) => s.id === req.params.id);
  if (existing && !assertSchoolAllowed(req, res, existing.school)) return;
  await db.deleteStudent(req.params.id);
  res.json({ ok: true });
}));

// ---------- Reminders ----------

app.get("/api/reminders", requireAuth, h(async (req, res) => {
  const all = await db.getReminders();
  const schools = req.user.schools;
  res.json(schools ? all.filter((r) => schools.includes(r.school)) : all);
}));

app.post("/api/reminders", requireAuth, h(async (req, res) => {
  const { studentId, name, school, phone, balance, message } = req.body;
  if (!assertSchoolAllowed(req, res, school)) return;
  const entry = {
    id: studentId + "-" + Date.now(),
    studentId,
    name,
    school,
    phone,
    balance,
    message,
    sentAt: new Date().toISOString(),
    sentBy: req.user.email,
  };
  res.status(201).json(await db.addReminder(entry));
}));

// ---------- Expenses ----------

const EXPENSE_AUDIT_FIELDS = ["school", "category", "description", "vendor", "amount", "date"];

app.get("/api/expenses", requireAuth, h(async (req, res) => {
  const all = await db.getExpenses();
  const schools = req.user.schools;
  res.json(schools ? all.filter((e) => schools.includes(e.school)) : all);
}));

app.post("/api/expenses", requireAuth, h(async (req, res) => {
  const { school, category, description, vendor, amount, date } = req.body;
  if (!school || !amount || !date) return res.status(400).json({ error: "school, amount, and date are required" });
  if (!assertSchoolAllowed(req, res, school)) return;
  const expense = {
    id: "e" + Date.now() + Math.random().toString(36).slice(2, 7),
    school, category: category || "Miscellaneous", description: description || "", vendor: vendor || "",
    amount: Number(amount), date,
    history: [{ field: "created", oldValue: null, newValue: null, by: req.user.email, at: new Date().toISOString() }],
  };
  res.status(201).json(await db.addExpense(expense));
}));

app.put("/api/expenses/:id", requireAuth, h(async (req, res) => {
  const all = await db.getExpenses();
  const existing = all.find((e) => e.id === req.params.id);
  if (!existing) return res.status(404).json({ error: "Expense not found" });
  if (!assertSchoolAllowed(req, res, existing.school)) return;
  if (req.body.school && !assertSchoolAllowed(req, res, req.body.school)) return;

  const patch = { ...req.body };
  if (patch.amount != null) patch.amount = Number(patch.amount);

  const changes = [];
  const now = new Date().toISOString();
  EXPENSE_AUDIT_FIELDS.forEach((field) => {
    if (field in patch && String(patch[field]) !== String(existing[field])) {
      changes.push({ field, oldValue: existing[field] ?? null, newValue: patch[field], by: req.user.email, at: now });
    }
  });
  if (changes.length) patch.history = [...(existing.history || []), ...changes];

  const updated = await db.updateExpense(req.params.id, patch);
  if (!updated) return res.status(404).json({ error: "Expense not found" });
  res.json(updated);
}));

app.delete("/api/expenses/:id", requireAuth, h(async (req, res) => {
  const all = await db.getExpenses();
  const existing = all.find((e) => e.id === req.params.id);
  if (existing && !assertSchoolAllowed(req, res, existing.school)) return;
  await db.deleteExpense(req.params.id);
  res.json({ ok: true });
}));

// ---------- Backup / restore ----------
// A manual safety net alongside the database itself. Any signed-in user can
// back up; restoring only ever overwrites the caller's own school scope
// unless they're an unrestricted (all-schools) account.

app.get("/api/backup", requireAuth, h(async (req, res) => {
  const data = await db.exportAll();
  const schools = req.user.schools;
  if (schools) {
    data.students = data.students.filter((s) => schools.includes(s.school));
    data.reminders = data.reminders.filter((r) => schools.includes(r.school));
    data.expenses = data.expenses.filter((e) => schools.includes(e.school));
  }
  res.setHeader("Content-Disposition", `attachment; filename="fee-ledger-backup-${new Date().toISOString().slice(0, 10)}.json"`);
  res.json(data);
}));

app.post("/api/backup/restore", requireAuth, h(async (req, res) => {
  const { students, reminders, expenses = [] } = req.body || {};
  if (!Array.isArray(students) || !Array.isArray(reminders)) {
    return res.status(400).json({ error: "Backup file must contain students[] and reminders[] arrays" });
  }
  const schools = req.user.schools;
  if (schools) {
    const bad = students.find((s) => !schools.includes(s.school));
    if (bad) return res.status(403).json({ error: `Backup contains students outside your allowed schools (${bad.school})` });
    const badExpense = expenses.find((e) => !schools.includes(e.school));
    if (badExpense) return res.status(403).json({ error: `Backup contains expenses outside your allowed schools (${badExpense.school})` });
    // Scoped accounts can only overwrite their own schools' data — merge rather than replace,
    // so a Blossom Heights admin restoring their backup can't wipe out Vardhman's records.
    const current = await db.exportAll();
    const keptStudents = current.students.filter((s) => !schools.includes(s.school));
    const keptReminders = current.reminders.filter((r) => !schools.includes(r.school));
    const keptExpenses = current.expenses.filter((e) => !schools.includes(e.school));
    await db.importAll({
      students: [...students, ...keptStudents],
      reminders: [...reminders, ...keptReminders],
      expenses: [...expenses, ...keptExpenses],
    });
  } else {
    await db.importAll({ students, reminders, expenses });
  }
  res.json({ ok: true, studentsRestored: students.length, remindersRestored: reminders.length, expensesRestored: expenses.length });
}));

// ---------- Automatic snapshots ----------
// One per day taken opportunistically (see ensureDailySnapshot in db.js), plus one
// right before every restore. Restricted to unrestricted (all-schools) accounts —
// scoped staff accounts should use the manual Backup button, which is already
// scoped to only their own school's data; these snapshots are full-database dumps.

function requireUnrestricted(req, res) {
  if (req.user.schools) {
    res.status(403).json({ error: "Only an all-schools account can manage automatic snapshots." });
    return false;
  }
  return true;
}

app.get("/api/backups", requireAuth, h(async (req, res) => {
  if (!requireUnrestricted(req, res)) return;
  res.json(await db.listSnapshots());
}));

app.get("/api/backups/:id", requireAuth, h(async (req, res) => {
  if (!requireUnrestricted(req, res)) return;
  const data = await db.getSnapshot(req.params.id);
  if (!data) return res.status(404).json({ error: "Snapshot not found" });
  res.setHeader("Content-Disposition", `attachment; filename="fee-ledger-snapshot-${req.params.id}.json"`);
  res.json(data);
}));

app.post("/api/backups/:id/restore", requireAuth, h(async (req, res) => {
  if (!requireUnrestricted(req, res)) return;
  const data = await db.getSnapshot(req.params.id);
  if (!data) return res.status(404).json({ error: "Snapshot not found" });
  await db.importAll(data); // this itself takes a fresh "pre-restore" snapshot of current state first
  res.json({ ok: true, studentsRestored: data.students.length, remindersRestored: data.reminders.length, expensesRestored: (data.expenses || []).length });
}));

app.get("/api/health", (req, res) => res.json({ ok: true }));

app.listen(PORT, () => console.log(`Fee Ledger API running on port ${PORT}`));
