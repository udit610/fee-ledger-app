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
const googleClient = new OAuth2Client(GOOGLE_CLIENT_ID);

const app = express();
app.use(express.json());
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

// ---------- Auth ----------

app.post("/api/auth/google", async (req, res) => {
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

  const user = { email, name: payload.name, picture: payload.picture };
  const token = jwt.sign(user, JWT_SECRET, { expiresIn: "14d" });
  res.cookie("session", token, cookieOpts);
  res.json({ user });
});

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

// ---------- Students ----------

app.get("/api/students", requireAuth, (req, res) => {
  res.json(db.getStudents());
});

app.post("/api/students", requireAuth, (req, res) => {
  const { name, cls, school, phone, total, paid, due, planType, frequency, installmentAmount, installments } = req.body;
  if (!name || !total || !due) return res.status(400).json({ error: "name, total, and due are required" });
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
  };
  res.status(201).json(db.addStudent(student));
});

app.post("/api/students/bulk-import", requireAuth, (req, res) => {
  const { students } = req.body;
  if (!Array.isArray(students)) return res.status(400).json({ error: "students must be an array" });
  const prepared = students
    .filter((r) => r.name && Number(r.total) > 0 && r.due)
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
    }));
  res.status(201).json(db.bulkAddStudents(prepared));
});

app.put("/api/students/:id", requireAuth, (req, res) => {
  const patch = { ...req.body };
  if (patch.total != null) patch.total = Number(patch.total);
  if (patch.paid != null) patch.paid = Number(patch.paid);
  const updated = db.updateStudent(req.params.id, patch);
  if (!updated) return res.status(404).json({ error: "Student not found" });
  res.json(updated);
});

app.post("/api/students/:id/payments", requireAuth, (req, res) => {
  const amount = Number(req.body.amount);
  if (!amount || amount <= 0) return res.status(400).json({ error: "amount must be a positive number" });
  const updated = db.addPayment(req.params.id, amount);
  if (!updated) return res.status(404).json({ error: "Student not found" });
  res.json(updated);
});

app.delete("/api/students/:id", requireAuth, (req, res) => {
  db.deleteStudent(req.params.id);
  res.json({ ok: true });
});

// ---------- Reminders ----------

app.get("/api/reminders", requireAuth, (req, res) => {
  res.json(db.getReminders());
});

app.post("/api/reminders", requireAuth, (req, res) => {
  const { studentId, name, school, phone, balance, message } = req.body;
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
  res.status(201).json(db.addReminder(entry));
});

app.get("/api/health", (req, res) => res.json({ ok: true }));

app.listen(PORT, () => console.log(`Fee Ledger API running on port ${PORT}`));
