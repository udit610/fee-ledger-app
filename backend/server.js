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
  const updated = await db.addPayment(req.params.id, amount);
  if (!updated) return res.status(404).json({ error: "Student not found" });
  res.json(updated);
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
  }
  res.setHeader("Content-Disposition", `attachment; filename="fee-ledger-backup-${new Date().toISOString().slice(0, 10)}.json"`);
  res.json(data);
}));

app.post("/api/backup/restore", requireAuth, h(async (req, res) => {
  const { students, reminders } = req.body || {};
  if (!Array.isArray(students) || !Array.isArray(reminders)) {
    return res.status(400).json({ error: "Backup file must contain students[] and reminders[] arrays" });
  }
  const schools = req.user.schools;
  if (schools) {
    const bad = students.find((s) => !schools.includes(s.school));
    if (bad) return res.status(403).json({ error: `Backup contains students outside your allowed schools (${bad.school})` });
    // Scoped accounts can only overwrite their own schools' data — merge rather than replace,
    // so a Blossom Heights admin restoring their backup can't wipe out Vardhman's records.
    const current = await db.exportAll();
    const keptStudents = current.students.filter((s) => !schools.includes(s.school));
    const keptReminders = current.reminders.filter((r) => !schools.includes(r.school));
    await db.importAll({ students: [...students, ...keptStudents], reminders: [...reminders, ...keptReminders] });
  } else {
    await db.importAll({ students, reminders });
  }
  res.json({ ok: true, studentsRestored: students.length, remindersRestored: reminders.length });
}));

app.get("/api/health", (req, res) => res.json({ ok: true }));

app.listen(PORT, () => console.log(`Fee Ledger API running on port ${PORT}`));
