import React, { useState, useEffect, useMemo, useRef } from "react";
import { Search, Plus, MessageCircle, X, Check, Clock, AlertTriangle, IndianRupee, Send, History, Trash2, Upload, Download, FileSpreadsheet, AlertCircle, Pencil, LogOut, ChevronDown, BarChart3, DatabaseBackup } from "lucide-react";
import * as XLSX from "xlsx";
import { api } from "./api.js";

const GOOGLE_CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID;
const SCHOOLS = ["Vardhman Convent School", "Blossom Heights Pre-School"];
const TEMPLATE_HEADERS = ["Name", "Class", "School", "Parent Phone", "Total Fee", "Paid", "Due Date", "Quarterly/Biannual Amount", "Monthly Amount"];

// Installment plan configs, keyed by frequency
const FREQ_CONFIG = {
  monthly: { count: 12, monthsApart: 1, label: "Month" },
  quarterly: { count: 4, monthsApart: 3, label: "Quarter" },
  biannual: { count: 2, monthsApart: 6, label: "Half" },
};

function isInstallmentPlan(s) {
  return s.planType === "monthly" || s.planType === "quarterly";
}

function planLabel(s) {
  if (s.planType === "monthly") return "Monthly · 12";
  if (s.planType === "quarterly") return s.frequency === "biannual" ? "Biannual · 2" : "Quarterly · 4";
  return "One-time";
}

// UI-only combined selector <-> {planType, frequency} mapping
const PLAN_SELECT_OPTIONS = [
  { value: "full", label: "One-time", planType: "full", frequency: null },
  { value: "monthly", label: "Monthly (12)", planType: "monthly", frequency: "monthly" },
  { value: "quarterly-quarterly", label: "Quarterly (4)", planType: "quarterly", frequency: "quarterly" },
  { value: "quarterly-biannual", label: "Biannual (2)", planType: "quarterly", frequency: "biannual" },
];

function planSelectValue(planType, frequency) {
  if (planType === "monthly") return "monthly";
  if (planType === "quarterly" && frequency === "biannual") return "quarterly-biannual";
  if (planType === "quarterly") return "quarterly-quarterly";
  return "full";
}

const FONT_IMPORT = `@import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@500;600&family=Inter:wght@400;500;600;700;800&display=swap');`;

const money = (n) => "₹" + Number(n || 0).toLocaleString("en-IN");
const todayISO = () => new Date().toISOString().slice(0, 10);
const daysBetween = (a, b) => Math.round((new Date(a) - new Date(b)) / 86400000);

function statusOf(student, today = todayISO()) {
  const balance = student.total - student.paid;
  if (balance <= 0) return "paid";
  return daysBetween(student.due, today) < 0 ? "overdue" : "pending";
}

function addMonths(dateStr, n) {
  const d = new Date(dateStr + "T00:00:00");
  const day = d.getDate();
  d.setMonth(d.getMonth() + n);
  // guard against month-length overflow (e.g. Jan 31 + 1mo)
  if (d.getDate() < day) d.setDate(0);
  return d.toISOString().slice(0, 10);
}

// Pure function: builds an installment schedule. frequency drives count/spacing.
function generateInstallments(planType, frequency, startDue, amount) {
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

// Marks installments paid sequentially (in order) until paidTotal is exhausted.
// Used on Excel import, where we only know a lump "Paid" total, not which periods.
function markInstallmentsFromPaidTotal(installments, paidTotal) {
  let remaining = Number(paidTotal) || 0;
  return installments.map((inst) => {
    if (remaining >= inst.amount && inst.amount > 0) {
      remaining -= inst.amount;
      return { ...inst, paid: true, paidDate: new Date().toISOString() };
    }
    return inst;
  });
}

// Derives total/paid/due for installment-plan students from their installments array.
// Full-plan students pass through unchanged (their total/paid/due are already authoritative).
function withComputed(student) {
  if (!isInstallmentPlan(student)) return student;
  const installments = student.installments || [];
  const total = installments.reduce((a, i) => a + Number(i.amount || 0), 0);
  const paid = installments.filter((i) => i.paid).reduce((a, i) => a + Number(i.amount || 0), 0);
  const nextUnpaid = installments.find((i) => !i.paid);
  const due = nextUnpaid ? nextUnpaid.due : (installments[installments.length - 1]?.due || student.due);
  return { ...student, total, paid, due };
}

function monthKey(iso) {
  return String(iso || "").slice(0, 7); // "YYYY-MM"
}
function monthLabel(key) {
  const [y, m] = key.split("-").map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString("en-IN", { month: "short", year: "2-digit" });
}

// Builds a "collected per month" series for the last `months` months from every
// student's payments log (each payment already carries a real date).
function collectionSeries(students, months = 6) {
  const now = new Date();
  const keys = Array.from({ length: months }, (_, i) => {
    const d = new Date(now.getFullYear(), now.getMonth() - (months - 1 - i), 1);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  });
  const totals = Object.fromEntries(keys.map((k) => [k, 0]));
  students.forEach((s) => {
    (s.payments || []).forEach((p) => {
      const k = monthKey(p.date);
      if (k in totals) totals[k] += Number(p.amount || 0);
    });
  });
  return keys.map((k) => ({ key: k, label: monthLabel(k), amount: totals[k] }));
}

function normName(s) {
  return String(s || "").trim().toLowerCase().replace(/\s+/g, " ");
}

// Flags an import row as a likely duplicate of an existing student (same name+class+school).
function findDuplicate(row, existingStudents) {
  return existingStudents.find(
    (s) => normName(s.name) === normName(row.name) && normName(s.cls) === normName(row.cls) && s.school === row.school
  );
}

// A student "needs a reminder" if they have a balance due within the next 3 days (or overdue)
// and haven't had one logged in the last 7 days, so the digest doesn't nag about someone just reminded.
function needsReminder(s, reminders) {
  if (s.status === "paid") return false;
  const daysUntilDue = daysBetween(s.due, todayISO());
  if (daysUntilDue > 3) return false;
  const recentlyReminded = reminders.some((r) => r.studentId === s.id && daysBetween(todayISO(), r.sentAt) <= 7);
  return !recentlyReminded;
}

const STATUS_META = {
  paid: { label: "Paid", color: "#248A3D", bg: "rgba(52,199,89,0.13)", icon: Check },
  pending: { label: "Due", color: "#C93400", bg: "rgba(255,149,0,0.14)", icon: Clock },
  overdue: { label: "Overdue", color: "#D70015", bg: "rgba(255,59,48,0.12)", icon: AlertTriangle },
};

function StampBadge({ status }) {
  const meta = STATUS_META[status];
  const Icon = meta.icon;
  return (
    <span className="stamp" style={{ color: meta.color, borderColor: meta.color, background: meta.bg }}>
      <Icon size={12} strokeWidth={2.5} />
      {meta.label}
    </span>
  );
}

function defaultTemplate(student) {
  if (isInstallmentPlan(student) && (student.installments || []).length) {
    const next = student.installments.find((i) => !i.paid);
    if (next) {
      return `Dear Parent, this is a reminder from ${student.school} that the ${next.period} fee of ${money(next.amount)} for ${student.name} (${student.cls}) is due on ${next.due}. Kindly pay at the earliest to avoid late charges. Thank you.`;
    }
  }
  const balance = student.total - student.paid;
  return `Dear Parent, this is a reminder from ${student.school} that a fee balance of ${money(balance)} for ${student.name} (${student.cls}) is due on ${student.due}. Kindly pay at the earliest to avoid late charges. Thank you.`;
}

function initials(name) {
  return String(name || "")
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase())
    .join("");
}

function waLink(phone, message) {
  let d = String(phone || "").replace(/\D/g, "");
  if (d.length === 10) d = "91" + d;
  return `https://wa.me/${d}?text=${encodeURIComponent(message)}`;
}

function exportLedger(students) {
  const rows = students.map((raw) => {
    const s = withComputed(raw);
    return {
      Name: s.name, Class: s.cls, School: s.school, "Parent Phone": s.phone,
      Plan: planLabel(s),
      "Total Fee": s.total, Paid: s.paid, Balance: s.total - s.paid, "Due Date": s.due, Status: statusOf(s),
    };
  });
  const ws = XLSX.utils.json_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Fee Ledger");
  XLSX.writeFile(wb, `fee-ledger-export-${todayISO()}.xlsx`);
}

function downloadTemplate() {
  const sample = [
    TEMPLATE_HEADERS,
    ["Aarav Sharma", "Grade 4", "Vardhman Convent School", "9876500011", 18000, 18000, "2026-06-10", "", ""],
    ["Ira Mehta", "Nursery", "Blossom Heights Pre-School", "9876500044", 9000, 0, "2026-07-01", "", ""],
    ["Vihaan Kapoor", "Grade 2", "Vardhman Convent School", "9876500022", "", 0, "2026-06-10", "", 1500],
    ["Myra Chopra", "Prep", "Blossom Heights Pre-School", "9876500033", "", 0, "2026-06-01", 4500, ""],
  ];
  const ws = XLSX.utils.aoa_to_sheet(sample);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Fee Ledger");
  XLSX.writeFile(wb, "fee-ledger-template.xlsx");
}

function excelDateToISO(value) {
  if (value == null || value === "") return "";
  if (typeof value === "number") {
    const d = XLSX.SSF.parse_date_code(value);
    if (!d) return "";
    return `${d.y}-${String(d.m).padStart(2, "0")}-${String(d.d).padStart(2, "0")}`;
  }
  const parsed = new Date(value);
  return !isNaN(parsed) ? parsed.toISOString().slice(0, 10) : String(value);
}

function normalizeKey(k) {
  return String(k || "").trim().toLowerCase().replace(/[^a-z]/g, "");
}

function parseWorkbook(arrayBuffer) {
  const wb = XLSX.read(arrayBuffer, { type: "array" });
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: "" });
  return rows.map((row, i) => {
    const map = {};
    Object.keys(row).forEach((k) => (map[normalizeKey(k)] = row[k]));
    const name = String(map["name"] || map["studentname"] || "").trim();
    const cls = String(map["class"] || map["grade"] || "").trim();
    const school = String(map["school"] || "").trim();
    const phone = String(map["parentphone"] || map["phone"] || map["whatsapp"] || "").trim();
    const paid = Number(map["paid"] || 0);
    const due = excelDateToISO(map["duedate"] || map["due"]);
    const monthlyAmount = Number(map["monthlyamount"] || 0);
    const qtrBiannualAmount = Number(map["quarterlybiannualamount"] || map["quarterlyamount"] || map["biannualamount"] || 0);

    let planType = "full";
    let frequency = null;
    let installmentAmount = 0;
    if (monthlyAmount > 0) {
      planType = "monthly";
      frequency = "monthly";
      installmentAmount = monthlyAmount;
    } else if (qtrBiannualAmount > 0) {
      // Excel can't distinguish Quarterly vs Biannual in one merged column — defaults to Quarterly.
      planType = "quarterly";
      frequency = "quarterly";
      installmentAmount = qtrBiannualAmount;
    }
    const total = planType === "full" ? Number(map["totalfee"] || map["total"] || 0) : installmentAmount * FREQ_CONFIG[frequency].count;

    const errors = [];
    if (!name) errors.push("Missing name");
    if (!total || total <= 0) errors.push("Missing/invalid total fee (or installment amount)");
    if (!due) errors.push("Missing/invalid due date");
    return {
      rowNum: i + 2, id: "tmp" + i, name, cls: cls || "—", school: school || SCHOOLS[0], phone,
      total, paid: paid || 0, due, planType, frequency, installmentAmount, errors,
    };
  });
}

// ---------------- Google Sign-In gate ----------------

function GoogleGate({ onLoggedIn }) {
  const btnRef = useRef(null);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!window.google || !GOOGLE_CLIENT_ID) return;
    window.google.accounts.id.initialize({
      client_id: GOOGLE_CLIENT_ID,
      callback: async (resp) => {
        try {
          const { user } = await api.loginWithGoogle(resp.credential);
          onLoggedIn(user);
        } catch (err) {
          setError(err.message || "Sign-in failed");
        }
      },
    });
    window.google.accounts.id.renderButton(btnRef.current, { theme: "filled_blue", size: "large", shape: "pill" });
  }, []);

  return (
    <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", padding: 20, background: "#F5F5F7" }}>
      <style>{`${FONT_IMPORT}`}</style>
      <div style={{ background: "#fff", border: "1px solid #E5E5EA", borderRadius: 16, padding: 32, width: "100%", maxWidth: 340, textAlign: "center", fontFamily: "-apple-system, BlinkMacSystemFont, 'Inter', sans-serif", boxShadow: "0 1px 2px rgba(0,0,0,0.04)" }}>
        <div style={{ width: 40, height: 40, borderRadius: 11, background: "#1D1D1F", color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 16px", fontWeight: 700, fontSize: 15, letterSpacing: -0.3 }}>
          FL
        </div>
        <div style={{ fontSize: 19, fontWeight: 700, color: "#1D1D1F", marginBottom: 6, letterSpacing: -0.3 }}>Fee Ledger</div>
        <p style={{ fontSize: 12.5, color: "#86868B", marginBottom: 22, lineHeight: 1.5 }}>Sign in with a Google account authorized for this ledger.</p>
        <div ref={btnRef} style={{ display: "flex", justifyContent: "center" }} />
        {!GOOGLE_CLIENT_ID && <p style={{ color: "#D70015", fontSize: 12, marginTop: 14 }}>VITE_GOOGLE_CLIENT_ID is not set — see .env.example</p>}
        {error && <p style={{ color: "#D70015", fontSize: 12.5, marginTop: 14 }}>{error}</p>}
      </div>
    </div>
  );
}

// ---------------- Main app ----------------

export default function App() {
  const [user, setUser] = useState(undefined); // undefined = checking, null = signed out

  useEffect(() => {
    api.me().then((r) => setUser(r.user)).catch(() => setUser(null));
  }, []);

  if (user === undefined) return <div style={{ minHeight: "100vh", background: "#F5F5F7" }} />;
  if (!user) return <GoogleGate onLoggedIn={setUser} />;
  return <FeeLedger user={user} onLogout={() => { api.logout().finally(() => setUser(null)); }} />;
}

function FeeLedger({ user, onLogout }) {
  const allowedSchools = user.schools && user.schools.length ? user.schools : SCHOOLS;
  const [students, setStudents] = useState([]);
  const [reminders, setReminders] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const [schoolFilter, setSchoolFilter] = useState(allowedSchools.length === 1 ? allowedSchools[0] : "All Schools");
  const [statusFilter, setStatusFilter] = useState("all");
  const [sortBy, setSortBy] = useState("name");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(new Set());
  const [showAdd, setShowAdd] = useState(false);
  const [showReminderPanel, setShowReminderPanel] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [showReports, setShowReports] = useState(false);
  const [showBackup, setShowBackup] = useState(false);
  const [snapshots, setSnapshots] = useState(null);
  const [toast, setToast] = useState(null);
  const [payModal, setPayModal] = useState(null);
  const [historyStudent, setHistoryStudent] = useState(null);
  const [scheduleStudentId, setScheduleStudentId] = useState(null);
  const [editingId, setEditingId] = useState(null);
  const [savingStudent, setSavingStudent] = useState(false);
  const [newStudent, setNewStudent] = useState({ name: "", cls: "", school: allowedSchools[0], phone: "", total: "", paid: "", due: "", planSelect: "full", installmentAmount: "" });
  const [showImport, setShowImport] = useState(false);
  const [importRows, setImportRows] = useState(null);
  const [importFileName, setImportFileName] = useState("");
  const [skipDuplicates, setSkipDuplicates] = useState(true);
  const fileInputRef = useRef(null);
  const backupFileRef = useRef(null);
  const [schoolMenuOpen, setSchoolMenuOpen] = useState(false);
  const schoolMenuRef = useRef(null);
  const pendingDeletesRef = useRef({}); // id -> timeout handle, for soft-delete undo

  useEffect(() => {
    function onClickOutside(e) {
      if (schoolMenuRef.current && !schoolMenuRef.current.contains(e.target)) setSchoolMenuOpen(false);
    }
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, []);

  useEffect(() => {
    Promise.all([api.getStudents(), api.getReminders()])
      .then(([s, r]) => { setStudents(s); setReminders(r); })
      .catch(() => setToast({ kind: "warn", text: "Couldn't reach the server." }))
      .finally(() => setLoaded(true));
  }, []);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), toast.action ? 6000 : 3200);
    return () => clearTimeout(t);
  }, [toast]);

  useEffect(() => {
    if (!showBackup || user.schools) return;
    api.listSnapshots().then(setSnapshots).catch(() => setSnapshots([]));
  }, [showBackup]);

  const filtered = useMemo(() => {
    let list = students
      .map((s) => withComputed(s))
      .map((s) => ({ ...s, status: statusOf(s), balance: s.total - s.paid, daysOverdue: -daysBetween(s.due, todayISO()) }))
      .filter((s) => (schoolFilter === "All Schools" ? true : s.school === schoolFilter))
      .filter((s) => (statusFilter === "all" ? true : s.status === statusFilter))
      .filter((s) => s.name.toLowerCase().includes(query.toLowerCase()));
    if (sortBy === "name") list.sort((a, b) => a.name.localeCompare(b.name));
    if (sortBy === "balance") list.sort((a, b) => b.balance - a.balance);
    if (sortBy === "overdue") list.sort((a, b) => b.daysOverdue - a.daysOverdue);
    return list;
  }, [students, schoolFilter, statusFilter, query, sortBy]);

  const stats = useMemo(() => {
    const pool = students.map((s) => withComputed(s)).map((s) => ({ ...s, status: statusOf(s) })).filter((s) => (schoolFilter === "All Schools" ? true : s.school === schoolFilter));
    return {
      count: pool.length,
      totalDue: pool.reduce((a, s) => a + (s.total - s.paid), 0),
      collected: pool.reduce((a, s) => a + s.paid, 0),
      totalFees: pool.reduce((a, s) => a + s.total, 0),
      overdue: pool.filter((s) => s.status === "overdue").length,
    };
  }, [students, schoolFilter]);

  const scheduleStudent = scheduleStudentId ? withComputed(students.find((s) => s.id === scheduleStudentId) || null) : null;
  useEffect(() => {
    if (scheduleStudentId && !students.find((s) => s.id === scheduleStudentId)) setScheduleStudentId(null);
  }, [students, scheduleStudentId]);

  const collectionPct = stats.totalFees > 0 ? Math.round((stats.collected / stats.totalFees) * 100) : 0;

  const digest = useMemo(() => {
    const pool = filtered; // already scoped to schoolFilter/status/search
    const dueSoon = pool.filter((s) => s.status === "pending" && daysBetween(s.due, todayISO()) <= 3);
    const overdue = pool.filter((s) => s.status === "overdue");
    const needsReminderList = pool.filter((s) => needsReminder(s, reminders));
    return { dueSoon, overdue, needsReminderList };
  }, [filtered, reminders]);

  const thisMonthCollected = useMemo(() => {
    const key = monthKey(todayISO());
    return students.reduce((total, raw) => {
      const school = raw.school;
      if (schoolFilter !== "All Schools" && school !== schoolFilter) return total;
      const sum = (raw.payments || []).filter((p) => monthKey(p.date) === key).reduce((a, p) => a + Number(p.amount || 0), 0);
      return total + sum;
    }, 0);
  }, [students, schoolFilter]);

  const monthlySeries = useMemo(() => {
    const pool = schoolFilter === "All Schools" ? students : students.filter((s) => s.school === schoolFilter);
    return collectionSeries(pool, 6);
  }, [students, schoolFilter]);

  const classBreakdown = useMemo(() => {
    const pool = students.map((s) => withComputed(s)).filter((s) => (schoolFilter === "All Schools" ? true : s.school === schoolFilter));
    const groups = {};
    pool.forEach((s) => {
      const key = schoolFilter === "All Schools" ? `${s.school} · ${s.cls}` : s.cls;
      if (!groups[key]) groups[key] = { key, count: 0, total: 0, collected: 0 };
      groups[key].count += 1;
      groups[key].total += s.total;
      groups[key].collected += s.paid;
    });
    return Object.values(groups).sort((a, b) => a.key.localeCompare(b.key));
  }, [students, schoolFilter]);

  function toggleSelect(id) {
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  function selectAllUnpaid() {
    setSelected(new Set(filtered.filter((s) => s.status !== "paid").map((s) => s.id)));
  }

  async function logSingleReminder(s) {
    const entry = { studentId: s.id, name: s.name, school: s.school, phone: s.phone, balance: s.total - s.paid, message: defaultTemplate(s) };
    try {
      const saved = await api.logReminder(entry);
      setReminders((r) => [saved, ...r]);
    } catch {}
  }

  async function sendReminders() {
    const targets = filtered.filter((s) => selected.has(s.id));
    if (targets.length === 0) return setToast({ kind: "warn", text: "Select at least one student." });
    for (const s of targets) await logSingleReminder(s);
    setToast({ kind: "ok", text: `Logged ${targets.length} reminder${targets.length > 1 ? "s" : ""} as sent.` });
    setSelected(new Set());
    setShowReminderPanel(false);
  }

  async function recordPayment(id, amount) {
    try {
      const updated = await api.recordPayment(id, amount);
      setStudents((prev) => prev.map((s) => (s.id === id ? updated : s)));
      setPayModal(null);
      setToast({ kind: "ok", text: "Payment recorded." });
    } catch (err) {
      setToast({ kind: "warn", text: err.message });
    }
  }

  async function markInstallmentPaid(studentId, period) {
    const s = students.find((x) => x.id === studentId);
    if (!s) return;
    const inst = (s.installments || []).find((i) => i.period === period);
    if (!inst || inst.paid) return;
    try {
      // Server marks this one installment paid atomically (row-locked) — we don't
      // send the array back ourselves, so a second person acting on the same
      // student at nearly the same time can't clobber this change. See db.js.
      const updated = await api.markInstallmentPaid(studentId, period);
      setStudents((prev) => prev.map((x) => (x.id === studentId ? updated : x)));
      setToast({ kind: "ok", text: `${inst.period} marked paid.` });
    } catch (err) {
      setToast({ kind: "warn", text: err.message });
    }
  }

  async function regenerateSchedule(studentId) {
    const s = students.find((x) => x.id === studentId);
    if (!s) return;
    if (!window.confirm("This rebuilds the payment schedule from scratch and clears all paid marks. Continue?")) return;
    try {
      // Server rebuilds the schedule itself (row-locked, same pattern as
      // markInstallmentPaid) rather than us computing it here and PUTing the
      // whole array back — keeps this safe even if acted on from two tabs at once.
      const updated = await api.regenerateSchedule(studentId);
      setStudents((prev) => prev.map((x) => (x.id === studentId ? updated : x)));
      setToast({ kind: "ok", text: "Schedule regenerated." });
    } catch (err) {
      setToast({ kind: "warn", text: err.message });
    }
  }

  async function saveStudent() {
    if (savingStudent) return; // guards against a double-click creating two identical students
    const plan = PLAN_SELECT_OPTIONS.find((p) => p.value === newStudent.planSelect) || PLAN_SELECT_OPTIONS[0];
    const isInstallment = plan.planType !== "full";

    if (!newStudent.name || !newStudent.due) {
      return setToast({ kind: "warn", text: "Name and due date are required." });
    }
    if (!isInstallment && !newStudent.total) {
      return setToast({ kind: "warn", text: "Total fee is required for a one-time plan." });
    }
    if (isInstallment && !newStudent.installmentAmount) {
      return setToast({ kind: "warn", text: "Installment amount is required for this plan." });
    }

    const base = { name: newStudent.name, cls: newStudent.cls, school: newStudent.school, phone: newStudent.phone };
    let payload;
    if (!isInstallment) {
      payload = { ...base, planType: "full", frequency: null, total: newStudent.total, paid: newStudent.paid, due: newStudent.due };
    } else if (!editingId) {
      // New installment-plan student: generate the schedule now.
      const installments = generateInstallments(plan.planType, plan.frequency, newStudent.due, newStudent.installmentAmount);
      const total = installments.reduce((a, i) => a + Number(i.amount || 0), 0);
      payload = { ...base, planType: plan.planType, frequency: plan.frequency, installmentAmount: Number(newStudent.installmentAmount), due: newStudent.due, total, paid: 0, installments };
    } else {
      // Editing an existing installment-plan student: update plan settings only.
      // The schedule itself is only rebuilt via the explicit "Regenerate schedule" action,
      // so in-progress paid marks aren't silently wiped by a routine edit.
      payload = { ...base, planType: plan.planType, frequency: plan.frequency, installmentAmount: Number(newStudent.installmentAmount) };
    }

    setSavingStudent(true);
    try {
      if (editingId) {
        const updated = await api.updateStudent(editingId, payload);
        setStudents((prev) => prev.map((s) => (s.id === editingId ? updated : s)));
        setToast({ kind: "ok", text: "Student updated." });
      } else {
        const created = await api.addStudent(payload);
        setStudents((prev) => [created, ...prev]);
        setToast({ kind: "ok", text: "Student added." });
      }
      setShowAdd(false);
      setEditingId(null);
      setNewStudent({ name: "", cls: "", school: allowedSchools[0], phone: "", total: "", paid: "", due: "", planSelect: "full", installmentAmount: "" });
    } catch (err) {
      setToast({ kind: "warn", text: err.message });
    } finally {
      setSavingStudent(false);
    }
  }

  function openEdit(s) {
    setEditingId(s.id);
    setNewStudent({
      name: s.name, cls: s.cls, school: s.school, phone: s.phone,
      total: String(s.total), paid: String(s.paid), due: s.due,
      planSelect: planSelectValue(s.planType, s.frequency),
      installmentAmount: s.installmentAmount ? String(s.installmentAmount) : "",
    });
    setShowAdd(true);
  }

  async function removeStudent(id) {
    const student = students.find((s) => s.id === id);
    if (!student) return;
    setStudents((prev) => prev.filter((s) => s.id !== id));
    const timeoutId = setTimeout(async () => {
      delete pendingDeletesRef.current[id];
      try {
        await api.deleteStudent(id);
      } catch {
        setToast({ kind: "warn", text: "Couldn't delete on server — refresh to check." });
      }
    }, 5000);
    pendingDeletesRef.current[id] = { timeoutId, student };
    setToast({
      kind: "ok",
      text: `Removed ${student.name}.`,
      action: {
        label: "Undo",
        onClick: () => {
          const pending = pendingDeletesRef.current[id];
          if (!pending) return;
          clearTimeout(pending.timeoutId);
          delete pendingDeletesRef.current[id];
          setStudents((prev) => [pending.student, ...prev]);
        },
      },
    });
  }

  function handleFileSelect(e) {
    const file = e.target.files[0];
    if (!file) return;
    setImportFileName(file.name);
    const reader = new FileReader();
    reader.onload = (evt) => {
      try {
        const rows = parseWorkbook(evt.target.result).map((r) => ({ ...r, duplicate: !!findDuplicate(r, students) }));
        setImportRows(rows);
      } catch {
        setToast({ kind: "warn", text: "Couldn't read that file." });
      }
    };
    reader.readAsArrayBuffer(file);
  }

  async function confirmImport() {
    const valid = importRows
      .filter((r) => r.name && r.total > 0 && r.due)
      .filter((r) => !(skipDuplicates && r.duplicate))
      .map(({ errors, rowNum, id, duplicate, ...s }) => {
        if (s.planType === "full") return s;
        const installments = markInstallmentsFromPaidTotal(
          generateInstallments(s.planType, s.frequency, s.due, s.installmentAmount),
          s.paid
        );
        const paid = installments.filter((i) => i.paid).reduce((a, i) => a + Number(i.amount || 0), 0);
        return { ...s, installments, paid };
      });
    if (valid.length === 0) return setToast({ kind: "warn", text: "No valid rows to import." });
    try {
      const created = await api.bulkImport(valid);
      setStudents((prev) => [...created, ...prev]);
      setToast({ kind: "ok", text: `Imported ${created.length} students.` });
      setShowImport(false);
      setImportRows(null);
      setImportFileName("");
      if (fileInputRef.current) fileInputRef.current.value = "";
    } catch (err) {
      setToast({ kind: "warn", text: err.message });
    }
  }

  const unpaidSelectable = filtered.filter((s) => s.status !== "paid");

  async function downloadBackup() {
    try {
      const data = await api.getBackup();
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `fee-ledger-backup-${todayISO()}.json`;
      a.click();
      URL.revokeObjectURL(url);
      setToast({ kind: "ok", text: "Backup downloaded." });
    } catch (err) {
      setToast({ kind: "warn", text: err.message });
    }
  }

  function handleBackupFileSelect(e) {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async (evt) => {
      try {
        const data = JSON.parse(evt.target.result);
        if (!window.confirm(`This restores ${data.students?.length ?? 0} students and ${data.reminders?.length ?? 0} reminders from this file, overwriting current data in your allowed school(s). Continue?`)) return;
        const result = await api.restoreBackup(data);
        setToast({ kind: "ok", text: `Restored ${result.studentsRestored} students.` });
        const [s, r] = await Promise.all([api.getStudents(), api.getReminders()]);
        setStudents(s);
        setReminders(r);
        setShowBackup(false);
      } catch (err) {
        setToast({ kind: "warn", text: err.message || "Couldn't read that backup file." });
      }
    };
    reader.readAsText(file);
    if (backupFileRef.current) backupFileRef.current.value = "";
  }

  async function restoreFromSnapshot(snap) {
    if (!window.confirm(`Restore the automatic snapshot from ${new Date(snap.taken_at).toLocaleString()} (${snap.student_count} students)? This overwrites current data — a fresh safety snapshot of what's there right now is taken automatically first.`)) return;
    try {
      const result = await api.restoreSnapshot(snap.id);
      setToast({ kind: "ok", text: `Restored ${result.studentsRestored} students from snapshot.` });
      const [s, r] = await Promise.all([api.getStudents(), api.getReminders()]);
      setStudents(s);
      setReminders(r);
      setShowBackup(false);
    } catch (err) {
      setToast({ kind: "warn", text: err.message });
    }
  }

  if (!loaded) return <div style={{ minHeight: "100vh", background: "#F5F5F7" }} />;

  return (
    <div className="wrap">
      <style>{`
        ${FONT_IMPORT}
        * { box-sizing: border-box; -webkit-font-smoothing: antialiased; }
        :root {
          --sans: -apple-system, BlinkMacSystemFont, 'SF Pro Display', 'SF Pro Text', 'Inter', sans-serif;
          --mono: ui-monospace, -apple-system, 'SF Mono', 'IBM Plex Mono', Menlo, monospace;
          --bg: #F5F5F7; --card: #ffffff;
          --ink: #1D1D1F; --text-soft: #6E6E73; --text-mute: #86868B;
          --line: #E5E5EA; --line-strong: #D2D2D7;
          --accent: #0071E3; --accent-dark: #0058B0; --accent-tint: rgba(0,113,227,0.1);
          --paid: #248A3D; --paid-bg: rgba(52,199,89,0.13);
          --due: #C93400; --due-bg: rgba(255,149,0,0.14);
          --over: #D70015; --over-bg: rgba(255,59,48,0.12);
          --whatsapp: #25D366;
        }
        @media (prefers-reduced-motion: reduce) { *, *::before, *::after { animation-duration: 0.01ms !important; transition-duration: 0.01ms !important; } }

        .wrap { min-height: 100vh; background: var(--bg); font-family: var(--sans); color: var(--ink); padding-bottom: 60px; -webkit-font-smoothing: antialiased; }
        h1,h2,h3 { font-family: var(--sans); }
        .mono { font-family: var(--mono); font-variant-numeric: tabular-nums; }
        a { color: inherit; }

        .header { background: rgba(255,255,255,0.82); backdrop-filter: blur(20px); -webkit-backdrop-filter: blur(20px); border-bottom: 1px solid var(--line); color: var(--ink); padding: 20px 24px 18px; position: relative; }
        .header-top { display:flex; align-items:center; justify-content:space-between; gap: 12px; flex-wrap: wrap; }
        .brand { display:flex; align-items:center; gap:10px; }
        .brand-mark { width: 34px; height: 34px; border-radius: 9px; background: var(--ink); color: #fff; display:flex; align-items:center; justify-content:center; font-family: var(--sans); font-weight:700; font-size: 14px; letter-spacing: -0.3px; }
        .brand-title { font-family: var(--sans); font-size: 19px; font-weight:700; letter-spacing: -0.3px; color: var(--ink); }
        .brand-sub { font-size: 12px; color: var(--text-mute); letter-spacing: 0px; margin-top: 1px; }

        .user-chip { display:flex; align-items:center; gap:8px; background: var(--bg); border:1px solid var(--line); padding: 4px 5px; border-radius: 999px; transition: background 0.15s ease; }
        .user-chip:hover { background: #ECECEE; }
        .user-chip img { width:22px; height:22px; border-radius:50%; display:block; }
        .icon-plain { background:none; border:none; color: var(--text-soft); cursor:pointer; display:flex; padding: 4px; border-radius: 6px; transition: color 0.15s ease; }
        .icon-plain:hover { color: var(--ink); }

        .select-field { background: var(--bg); border: 1px solid var(--line); color: var(--ink); padding: 7px 28px 7px 12px; border-radius: 8px; font-size: 13px; font-weight: 500; appearance: none; background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6'%3E%3Cpath d='M1 1l4 4 4-4' stroke='%236E6E73' stroke-width='1.4' fill='none'/%3E%3C/svg%3E"); background-repeat: no-repeat; background-position: right 11px center; cursor: pointer; transition: border-color 0.15s ease, background 0.15s ease; }
        .select-field:hover { background: #ECECEE; }
        .select-field.light { background-color: #FAFAFA; border: 1px solid var(--line); color: var(--ink); background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6'%3E%3Cpath d='M1 1l4 4 4-4' stroke='%236E6E73' stroke-width='1.4' fill='none'/%3E%3C/svg%3E"); }
        .dropdown-wrap { position: relative; }
        .dropdown-trigger { display:flex; align-items:center; gap: 7px; background: var(--bg); border: 1px solid var(--line); color: var(--ink); padding: 7px 12px; border-radius: 8px; font-size: 13px; font-weight: 500; cursor: pointer; transition: background 0.15s ease; }
        .dropdown-trigger:hover { background: #ECECEE; }
        .dropdown-menu { position: absolute; top: calc(100% + 6px); left: 0; min-width: 220px; max-width: calc(100vw - 32px); background: rgba(255,255,255,0.96); backdrop-filter: blur(20px); -webkit-backdrop-filter: blur(20px); border: 1px solid var(--line); border-radius: 12px; box-shadow: 0 12px 28px rgba(0,0,0,0.12); padding: 5px; z-index: 40; animation: dropIn 0.14s ease; }
        @keyframes dropIn { from { opacity: 0; transform: translateY(-4px); } to { opacity: 1; transform: translateY(0); } }
        .dropdown-item { display:flex; align-items:center; justify-content:space-between; gap: 8px; width: 100%; text-align:left; background: none; border: none; padding: 8px 10px; border-radius: 7px; font-size: 13.5px; color: var(--ink); cursor: pointer; transition: background 0.1s ease; }
        .dropdown-item:hover { background: var(--bg); }
        .dropdown-item.active { color: var(--accent); font-weight: 600; }
        .dropdown-item.active svg { color: var(--accent); }

        /* Signature element: a quiet, confident collection meter — plain track, single accent fill, numbers do the talking */
        .meter-row { display:flex; align-items:baseline; gap: 12px; margin-top: 22px; }
        .meter-track { flex:1; height: 6px; border-radius: 999px; background: var(--line); overflow:hidden; position: relative; align-self: center; }
        .meter-fill { height: 100%; background: var(--accent); border-radius: 999px; transition: width 0.6s cubic-bezier(0.22,1,0.36,1); }
        .meter-label { font-size: 12px; color: var(--text-mute); white-space: nowrap; }
        .meter-pct { font-family: var(--mono); font-size: 17px; font-weight: 700; color: var(--ink); white-space: nowrap; letter-spacing: -0.3px; }

        .stats-row { display: grid; grid-template-columns: repeat(2, 1fr); gap: 1px; margin-top: 18px; background: var(--line); border: 1px solid var(--line); border-radius: 12px; overflow: hidden; }
        @media (min-width: 720px) { .stats-row { grid-template-columns: repeat(4, 1fr); } }
        .stat-card { position:relative; background: rgba(255,255,255,0.9); padding: 13px 16px; }
        .stat-label { font-size: 11.5px; color: var(--text-mute); margin-bottom: 5px; font-weight: 500; }
        .stat-value { font-family: var(--mono); font-size: 19px; font-weight: 700; color: var(--ink); letter-spacing: -0.3px; }
        .stat-value.amber { color: var(--due); } .stat-value.red { color: var(--over); }

        .note-banner { background: var(--accent-tint); border:1px solid rgba(0,113,227,0.18); color: var(--accent-dark); font-size:12.5px; line-height: 1.5; border-radius:10px; padding:10px 14px; margin: 14px 20px 0; max-width:1040px; margin-left:auto; margin-right:auto; }
        .digest-banner { display:flex; align-items:center; justify-content:space-between; gap: 12px; flex-wrap:wrap; background: var(--over-bg); border:1px solid rgba(255,59,48,0.2); color:#8E0010; font-size:12.5px; line-height: 1.5; border-radius:10px; padding:10px 14px; margin: 10px 20px 0; max-width:1040px; margin-left:auto; margin-right:auto; }
        .digest-text strong { color: var(--over); }

        .toolbar { max-width: 1080px; margin: -14px auto 0; padding: 0 20px; }
        .toolbar-card { background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 10px; display:flex; flex-wrap:wrap; gap:8px; align-items:center; box-shadow: 0 1px 2px rgba(0,0,0,0.03); }
        .search-box { display:flex; align-items:center; gap:8px; flex:1; min-width: 170px; border:1px solid var(--line); border-radius:8px; padding:8px 12px; background: var(--bg); transition: border-color 0.15s ease, background 0.15s ease; }
        .search-box:focus-within { border-color: var(--accent); background: #fff; }
        .search-box input { border:none; outline:none; background:transparent; font-size: 14px; width:100%; color: var(--ink); font-family: var(--sans); }
        .pill-select { border:1px solid var(--line); border-radius:8px; padding:8px 26px 8px 10px; font-size:13px; font-weight: 500; background-color: var(--bg); color:var(--ink); appearance:none; background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6'%3E%3Cpath d='M1 1l4 4 4-4' stroke='%236E6E73' stroke-width='1.4' fill='none'/%3E%3C/svg%3E"); background-repeat:no-repeat; background-position: right 9px center; cursor:pointer; transition: background 0.15s ease; }
        .pill-select:hover { background-color: #ECECEE; }

        /* Segmented control — iOS-style status filter */
        .segmented { display:flex; background: var(--bg); border: 1px solid var(--line); padding: 2px; border-radius: 9px; gap: 2px; }
        .segmented button { border:none; background:transparent; padding: 7px 11px; font-size: 12.5px; font-weight: 500; color: var(--text-soft); border-radius: 7px; cursor: pointer; transition: background 0.15s ease, color 0.15s ease, box-shadow 0.15s ease; white-space: nowrap; }
        .segmented button.active { background: #fff; color: var(--ink); font-weight: 600; box-shadow: 0 1px 3px rgba(0,0,0,0.12); }

        .btn { border:none; border-radius:8px; padding:8px 14px; font-size:13.5px; font-weight:600; display:flex; align-items:center; gap:6px; cursor:pointer; white-space:nowrap; transition: opacity 0.12s ease, background 0.15s ease; font-family: var(--sans); }
        .btn:active { opacity: 0.75; }
        .btn-primary { background: var(--accent); color: #fff; }
        .btn-primary:hover { background: #0077ED; }
        .btn-whatsapp { background: var(--whatsapp); color:#fff; }
        .btn-whatsapp:hover { background: #21BD5C; }
        .btn-ghost { background: var(--bg); color: var(--ink); border:1px solid var(--line); }
        .btn-ghost:hover { background: #ECECEE; }

        .content { max-width: 1080px; margin: 20px auto 0; padding: 0 20px; }
        .section-label { font-size: 11.5px; text-transform: uppercase; letter-spacing: 0.4px; color:var(--text-mute); margin: 18px 0 8px 4px; display:flex; justify-content: space-between; align-items:center; font-weight: 600; }

        .ledger { background: var(--card); border:1px solid var(--line); border-radius: 12px; overflow:hidden; box-shadow: 0 1px 2px rgba(0,0,0,0.03); }
        .row { display:grid; grid-template-columns: 20px 36px 1fr auto; gap: 12px; align-items:center; padding: 13px 16px; border-bottom: 1px solid var(--line); transition: background 0.1s ease; }
        .row:last-child { border-bottom: none; }
        .row:hover { background: #FBFBFC; }
        .avatar { width: 32px; height: 32px; border-radius: 50%; display:flex; align-items:center; justify-content:center; font-family: var(--mono); font-weight: 600; font-size: 11.5px; flex-shrink:0; }
        .row-name { font-weight:600; font-size:14.5px; color: var(--ink); letter-spacing: -0.1px; }
        .row-sub { font-size:12px; color:var(--text-mute); margin-top:2px; }
        .plan-chip { display:inline-flex; align-items:center; font-size:10.5px; font-weight:600; color: var(--text-soft); background: var(--bg); border: 1px solid var(--line); border-radius: 999px; padding: 2px 8px; margin-top: 5px; }
        .progress-track { height: 3px; border-radius: 999px; background: var(--line); margin-top: 6px; width: 140px; max-width: 60%; overflow:hidden; }
        .progress-fill { height: 100%; border-radius: 999px; transition: width 0.4s ease; }
        .row-right { display:flex; align-items:center; gap:12px; }
        .amounts { text-align:right; cursor: default; }
        .amounts.clickable { cursor:pointer; border-radius: 6px; padding: 2px 4px; margin: -2px -4px; transition: background 0.12s ease; }
        .amounts.clickable:hover { background: var(--bg); }
        .amt-balance { font-family: var(--mono); font-weight:700; font-size:14.5px; color: var(--ink); letter-spacing: -0.2px; }
        .amt-sub { font-size:11px; color:var(--text-mute); }
        .stamp { display:inline-flex; align-items:center; gap:5px; font-size: 10.5px; font-weight:600; letter-spacing: 0.1px; padding: 4px 9px; border-radius: 999px; }
        .row-actions { display:flex; gap:4px; }
        .icon-btn { border:none; background: var(--bg); border-radius:7px; width:29px; height:29px; display:flex; align-items:center; justify-content:center; cursor:pointer; color:var(--text-soft); transition: background 0.12s ease, color 0.12s ease; }
        .icon-btn:hover { background: #ECECEE; color: var(--ink); }
        .checkbox { width:16px; height:16px; accent-color: var(--accent); cursor:pointer; }

        .empty { padding: 52px 24px; text-align:center; }
        .empty-title { font-family: var(--sans); font-size: 16px; font-weight: 600; color: var(--ink); margin-bottom: 4px; }
        .empty-body { font-size: 13px; color: var(--text-mute); }

        .modal-backdrop { position:fixed; inset:0; background:rgba(0,0,0,0.35); backdrop-filter: blur(2px); display:flex; align-items:flex-end; justify-content:center; z-index:50; animation: fadeIn 0.15s ease; }
        @media (min-width:720px) { .modal-backdrop { align-items:center; } }
        @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
        @keyframes slideUp { from { transform: translateY(16px); opacity: 0; } to { transform: translateY(0); opacity: 1; } }
        .modal { background: #ffffff; width:100%; max-width:480px; border-radius: 16px 16px 0 0; padding:20px; max-height:88vh; overflow:auto; animation: slideUp 0.22s cubic-bezier(0.22,1,0.36,1); border: 1px solid var(--line); }
        @media (min-width:720px) { .modal { border-radius:16px; } }
        .modal-head { display:flex; justify-content:space-between; align-items:center; margin-bottom:16px; }
        .modal-title { font-family: var(--sans); font-size:18px; font-weight:700; color: var(--ink); letter-spacing: -0.3px; }
        .field { margin-bottom: 12px; }
        .field label { font-size:12px; font-weight:600; color:var(--text-soft); display:block; margin-bottom:5px; }
        .field input, .field select { width:100%; border:1px solid var(--line); border-radius:8px; padding:9px 11px; font-size:14px; font-family: var(--sans); background: #fff; transition: border-color 0.15s ease; }
        .field input:focus, .field select:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-tint); }
        .field-row { display:grid; grid-template-columns: 1fr 1fr; gap:10px; }

        .reminder-item { border:1px solid var(--line); border-radius:10px; padding:10px 12px; margin-bottom:8px; transition: border-color 0.12s ease; background: #fff; }
        .reminder-item:hover { border-color: var(--line-strong); }
        .reminder-item label { display:flex; align-items:flex-start; gap:10px; cursor:pointer; }
        .reminder-msg { font-size:12.5px; color:var(--text-soft); margin-top:6px; line-height:1.45; background: var(--bg); border-radius:8px; padding:8px; }

        .toast { position:fixed; bottom:18px; left:50%; transform:translateX(-50%); background: rgba(29,29,31,0.94); backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px); color: #fff; padding:11px 18px; border-radius:12px; font-size:13.5px; display:flex; align-items:center; gap:8px; z-index:60; box-shadow: 0 12px 28px rgba(0,0,0,0.25); animation: toastIn 0.2s cubic-bezier(0.22,1,0.36,1); }
        @keyframes toastIn { from { transform: translate(-50%, 10px); opacity: 0; } to { transform: translate(-50%, 0); opacity: 1; } }
        .toast.warn { background: rgba(201,52,0,0.94); }
        .toast-action { background: rgba(255,255,255,0.2); border:none; color:#fff; font-weight:600; font-size:12.5px; padding:5px 10px; border-radius:7px; cursor:pointer; margin-left: 4px; }
        .toast-action:hover { background: rgba(255,255,255,0.3); }

        .history-item { padding:12px 14px; border-bottom:1px solid var(--line); }
        .history-item:last-child { border-bottom:none; }
        .history-top { display:flex; justify-content:space-between; font-size:13px; font-weight:600; }
        .history-time { font-size:11px; color:var(--text-mute); }
        .history-msg { font-size:12.5px; color:var(--text-soft); margin-top:4px; }

        .report-section-label { font-size: 11.5px; text-transform: uppercase; letter-spacing: 0.4px; color:var(--text-mute); margin-bottom: 10px; font-weight: 600; }
        .bar-chart { display:flex; align-items:flex-end; gap: 10px; height: 140px; padding: 0 4px; }
        .bar-col { flex:1; display:flex; flex-direction:column; align-items:center; height:100%; justify-content:flex-end; }
        .bar-value { font-size: 10px; color: var(--text-mute); margin-bottom: 4px; white-space:nowrap; }
        .bar-track { width: 100%; max-width: 34px; flex:1; display:flex; align-items:flex-end; background: var(--bg); border-radius: 4px 4px 0 0; overflow:hidden; }
        .bar-fill { width:100%; background: var(--accent); border-radius: 4px 4px 0 0; transition: height 0.4s ease; min-height: 2px; }
        .bar-label { font-size: 10.5px; color: var(--text-mute); margin-top: 6px; }
        .report-table { width:100%; border-collapse: collapse; font-size: 12.5px; }
        .report-table th { text-align:left; font-size: 10.5px; text-transform:uppercase; letter-spacing:0.4px; color:var(--text-mute); padding: 6px 8px; border-bottom: 1px solid var(--line); position: sticky; top:0; background: var(--card); }
        .report-table td { padding: 7px 8px; border-bottom: 1px solid var(--line); }
        .report-table td.mono, .report-table th:not(:first-child) { text-align:right; }

        /* ---- Mobile polish ---- */
        @media (max-width: 600px) {
          .field input, .field select { font-size: 16px; } /* prevents iOS Safari auto-zoom-on-focus */
          .icon-btn { width: 34px; height: 34px; }
          .checkbox { width: 19px; height: 19px; }
          .row { grid-template-columns: 18px 32px 1fr; row-gap: 10px; padding: 12px; }
          .row-right { grid-column: 1 / -1; justify-content: space-between; padding-left: 44px; }
          .amt-sub { display: none; }
          .toolbar-card .btn span, .toolbar-card .btn { font-size: 12.5px; padding: 8px 10px; }
          .header { padding: 18px 16px 16px; }
          .stats-row { grid-template-columns: repeat(2, 1fr); }
          .modal { padding: 16px; max-height: 92vh; }
          .field-row { grid-template-columns: 1fr; }
          .bar-chart { gap: 6px; }
        }
      `}</style>

      <div className="header">
        <div className="header-top">
          <div className="brand">
            <div className="brand-mark">FL</div>
            <div>
              <div className="brand-title">Fee Ledger</div>
              <div className="brand-sub">{user.email}</div>
            </div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            {allowedSchools.length > 1 && (
              <div className="dropdown-wrap" ref={schoolMenuRef}>
                <button className="dropdown-trigger" onClick={() => setSchoolMenuOpen((o) => !o)}>
                  <span>{schoolFilter}</span>
                  <ChevronDown size={14} style={{ transform: schoolMenuOpen ? "rotate(180deg)" : "none", transition: "transform 0.15s ease" }} />
                </button>
                {schoolMenuOpen && (
                  <div className="dropdown-menu">
                    {["All Schools", ...allowedSchools].map((opt) => (
                      <button
                        key={opt}
                        className={`dropdown-item ${schoolFilter === opt ? "active" : ""}`}
                        onClick={() => { setSchoolFilter(opt); setSchoolMenuOpen(false); }}
                      >
                        {opt}
                        {schoolFilter === opt && <Check size={14} />}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
            <div className="user-chip">
              {user.picture && <img src={user.picture} alt="" />}
              <button onClick={onLogout} title="Sign out" className="icon-plain">
                <LogOut size={15} />
              </button>
            </div>
          </div>
        </div>

        <div className="meter-row">
          <span className="meter-label">Collected</span>
          <div className="meter-track">
            <div className="meter-fill" style={{ width: `${collectionPct}%` }} />
          </div>
          <span className="meter-pct mono">{collectionPct}%</span>
        </div>

        <div className="stats-row">
          <div className="stat-card"><div className="stat-label">Students</div><div className="stat-value">{stats.count}</div></div>
          <div className="stat-card"><div className="stat-label">Collected</div><div className="stat-value">{money(stats.collected)}</div></div>
          <div className="stat-card"><div className="stat-label">Balance due</div><div className="stat-value amber">{money(stats.totalDue)}</div></div>
          <div className="stat-card"><div className="stat-label">Overdue</div><div className="stat-value red">{stats.overdue}</div></div>
          <div className="stat-card"><div className="stat-label">Collected this month</div><div className="stat-value">{money(thisMonthCollected)}</div></div>
        </div>
      </div>

      <div className="note-banner">
        Tap a green WhatsApp icon to open a pre-filled reminder — one tap per parent. Signed in as {user.email}, stored on your own server.
      </div>

      {(digest.dueSoon.length > 0 || digest.overdue.length > 0) && (
        <div className="digest-banner">
          <div className="digest-text">
            <strong>Today:</strong>{" "}
            {digest.overdue.length > 0 && <span>{digest.overdue.length} overdue</span>}
            {digest.overdue.length > 0 && digest.dueSoon.length > 0 && " · "}
            {digest.dueSoon.length > 0 && <span>{digest.dueSoon.length} due within 3 days</span>}
            {digest.needsReminderList.length > 0 && <span> · {digest.needsReminderList.length} not reminded in the last 7 days</span>}
          </div>
          {digest.needsReminderList.length > 0 && (
            <button
              className="btn btn-whatsapp"
              onClick={() => { setSelected(new Set(digest.needsReminderList.map((s) => s.id))); setShowReminderPanel(true); }}
            >
              <MessageCircle size={14} /> Remind {digest.needsReminderList.length}
            </button>
          )}
        </div>
      )}


      <div className="toolbar">
        <div className="toolbar-card">
          <div className="search-box">
            <Search size={16} color="#86868B" />
            <input placeholder="Search student..." value={query} onChange={(e) => setQuery(e.target.value)} />
          </div>
          <div className="segmented">
            {[["all", "All"], ["pending", "Due"], ["overdue", "Overdue"], ["paid", "Paid"]].map(([val, label]) => (
              <button key={val} className={statusFilter === val ? "active" : ""} onClick={() => setStatusFilter(val)}>{label}</button>
            ))}
          </div>
          <select className="pill-select" value={sortBy} onChange={(e) => setSortBy(e.target.value)}>
            <option value="name">Sort: Name</option>
            <option value="overdue">Sort: Most overdue</option>
            <option value="balance">Sort: Highest balance</option>
          </select>
          <button className="btn btn-ghost" onClick={() => exportLedger(students)}><Download size={15} /> Export</button>
          <button className="btn btn-ghost" onClick={() => setShowReports(true)}><BarChart3 size={15} /> Reports</button>
          <button className="btn btn-ghost" onClick={() => setShowHistory(true)}><History size={15} /> History</button>
          <button className="btn btn-ghost" onClick={() => setShowBackup(true)}><DatabaseBackup size={15} /> Backup</button>
          <button className="btn btn-whatsapp" onClick={() => { selectAllUnpaid(); setShowReminderPanel(true); }}><MessageCircle size={15} /> Send Reminders</button>
          <button className="btn btn-ghost" onClick={() => setShowImport(true)}><FileSpreadsheet size={15} /> Import Excel</button>
          <button className="btn btn-primary" onClick={() => setShowAdd(true)}><Plus size={15} /> Add Student</button>
        </div>
      </div>

      <div className="content">
        <div className="section-label">
          <span>Fee ledger — {filtered.length} record{filtered.length !== 1 ? "s" : ""}</span>
        </div>
        <div className="ledger">
          {filtered.length === 0 && (
            <div className="empty">
              <div className="empty-title">{students.length === 0 ? "No students yet" : "No matches"}</div>
              <div className="empty-body">
                {students.length === 0 ? "Add a student or import a spreadsheet to start the ledger." : "Try a different search, filter, or status."}
              </div>
            </div>
          )}
          {filtered.map((s) => {
            const balance = s.total - s.paid;
            const pct = s.total > 0 ? Math.min(100, Math.round((s.paid / s.total) * 100)) : 0;
            const meta = STATUS_META[s.status];
            const installment = isInstallmentPlan(s);
            const paidCount = installment ? (s.installments || []).filter((i) => i.paid).length : 0;
            const totalCount = installment ? (s.installments || []).length : 0;
            return (
              <div className="row" key={s.id}>
                <input type="checkbox" className="checkbox" checked={selected.has(s.id)} onChange={() => toggleSelect(s.id)} disabled={s.status === "paid"} />
                <div className="avatar" style={{ background: meta.bg, color: meta.color }}>{initials(s.name)}</div>
                <div>
                  <div className="row-name">{s.name}</div>
                  <div className="row-sub">
                    {s.cls} · {s.school} · Due {s.due}
                    {s.status === "overdue" && <span style={{ color: "var(--over)", fontWeight: 600 }}> · {s.daysOverdue}d overdue</span>}
                  </div>
                  {installment && (
                    <span className="plan-chip">{planLabel(s)} · {paidCount}/{totalCount} paid</span>
                  )}
                  <div className="progress-track"><div className="progress-fill" style={{ width: `${pct}%`, background: meta.color }} /></div>
                </div>
                <div className="row-right">
                  <div className="amounts clickable" onClick={() => (installment ? setScheduleStudentId(s.id) : setHistoryStudent(s))}>
                    <div className="amt-balance">{balance > 0 ? money(balance) : "Paid"}</div>
                    <div className="amt-sub">of {money(s.total)}</div>
                  </div>
                  <StampBadge status={s.status} />
                  <div className="row-actions">
                    {balance > 0 && s.phone && (
                      <a className="icon-btn" title="Send WhatsApp now" href={waLink(s.phone, defaultTemplate(s))} target="_blank" rel="noreferrer" onClick={() => logSingleReminder(s)}>
                        <MessageCircle size={14} />
                      </a>
                    )}
                    {balance > 0 && (
                      <button className="icon-btn" title={installment ? "View schedule" : "Record payment"} onClick={() => (installment ? setScheduleStudentId(s.id) : setPayModal(s))}>
                        <IndianRupee size={14} />
                      </button>
                    )}
                    <button className="icon-btn" title="Edit" onClick={() => openEdit(s)}><Pencil size={14} /></button>
                    <button className="icon-btn" title="Remove" onClick={() => removeStudent(s.id)}><Trash2 size={14} /></button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {showAdd && (
        <div className="modal-backdrop" onClick={() => { setShowAdd(false); setEditingId(null); }}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <div className="modal-title">{editingId ? "Edit student" : "Add student"}</div>
              <button className="icon-btn" onClick={() => { setShowAdd(false); setEditingId(null); }}><X size={16} /></button>
            </div>
            <div className="field"><label>Student name</label><input value={newStudent.name} onChange={(e) => setNewStudent({ ...newStudent, name: e.target.value })} /></div>
            <div className="field-row">
              <div className="field"><label>Class</label><input value={newStudent.cls} onChange={(e) => setNewStudent({ ...newStudent, cls: e.target.value })} /></div>
              <div className="field"><label>School</label><select value={newStudent.school} onChange={(e) => setNewStudent({ ...newStudent, school: e.target.value })}>{allowedSchools.map((s) => <option key={s}>{s}</option>)}</select></div>
            </div>
            <div className="field"><label>Parent WhatsApp number</label><input value={newStudent.phone} onChange={(e) => setNewStudent({ ...newStudent, phone: e.target.value })} placeholder="98XXXXXXXX" /></div>
            <div className="field">
              <label>Payment plan</label>
              <select value={newStudent.planSelect} onChange={(e) => setNewStudent({ ...newStudent, planSelect: e.target.value })}>
                {PLAN_SELECT_OPTIONS.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
              </select>
            </div>
            {newStudent.planSelect === "full" ? (
              <>
                <div className="field-row">
                  <div className="field"><label>Total fee (₹)</label><input type="number" value={newStudent.total} onChange={(e) => setNewStudent({ ...newStudent, total: e.target.value })} /></div>
                  <div className="field"><label>Already paid (₹)</label><input type="number" value={newStudent.paid} onChange={(e) => setNewStudent({ ...newStudent, paid: e.target.value })} /></div>
                </div>
                <div className="field"><label>Due date</label><input type="date" value={newStudent.due} onChange={(e) => setNewStudent({ ...newStudent, due: e.target.value })} /></div>
              </>
            ) : (
              <>
                <div className="field">
                  <label>{newStudent.planSelect === "monthly" ? "Monthly amount (₹)" : "Quarterly/Biannual amount (₹)"}</label>
                  <input type="number" value={newStudent.installmentAmount} onChange={(e) => setNewStudent({ ...newStudent, installmentAmount: e.target.value })} />
                </div>
                <div className="field"><label>First installment due date</label><input type="date" value={newStudent.due} onChange={(e) => setNewStudent({ ...newStudent, due: e.target.value })} /></div>
                {editingId && <p style={{ fontSize: 12, color: "#86868B", marginTop: -4, marginBottom: 12 }}>Saving here only updates the plan settings. To rebuild the schedule itself, use "Regenerate schedule" from the Schedule view.</p>}
              </>
            )}
            <button className="btn btn-primary" style={{ width: "100%", justifyContent: "center", opacity: savingStudent ? 0.6 : 1 }} disabled={savingStudent} onClick={saveStudent}>{savingStudent ? "Saving…" : editingId ? "Save changes" : "Add to ledger"}</button>
          </div>
        </div>
      )}

      {showImport && (
        <div className="modal-backdrop" onClick={() => { setShowImport(false); setImportRows(null); }}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head"><div className="modal-title">Import from Excel</div><button className="icon-btn" onClick={() => { setShowImport(false); setImportRows(null); }}><X size={16} /></button></div>
            {!importRows && (
              <>
                <p style={{ fontSize: 13, color: "#6E6E73", marginBottom: 12 }}>Columns: <strong>Name, Class, School, Parent Phone, Total Fee, Paid, Due Date</strong></p>
                <button className="btn btn-ghost" style={{ width: "100%", justifyContent: "center", marginBottom: 10 }} onClick={downloadTemplate}><Download size={15} /> Download template</button>
                <label className="btn btn-primary" style={{ width: "100%", justifyContent: "center", cursor: "pointer" }}>
                  <Upload size={15} /> Choose file
                  <input ref={fileInputRef} type="file" accept=".xlsx,.xls,.csv" style={{ display: "none" }} onChange={handleFileSelect} />
                </label>
              </>
            )}
            {importRows && (
              <>
                <p style={{ fontSize: 13, marginBottom: 10 }}>Found {importRows.length} rows in {importFileName}.</p>
                {importRows.some((r) => r.duplicate) && (
                  <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12.5, color: "#6E6E73", marginBottom: 10, cursor: "pointer" }}>
                    <input type="checkbox" className="checkbox" checked={skipDuplicates} onChange={(e) => setSkipDuplicates(e.target.checked)} />
                    Skip rows that match an existing student (same name, class, school)
                  </label>
                )}
                <div style={{ maxHeight: 320, overflow: "auto", marginBottom: 12 }}>
                  {importRows.map((r) => (
                    <div key={r.id} className="reminder-item" style={{ background: r.errors.length ? "rgba(255,59,48,0.12)" : r.duplicate ? "rgba(255,149,0,0.14)" : "#fff" }}>
                      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, fontWeight: 600 }}><span>Row {r.rowNum}: {r.name || "(no name)"}</span><span className="mono">{money(r.total)}</span></div>
                      <div style={{ fontSize: 12, color: "#86868B" }}>{r.cls} · {r.school} · Due {r.due || "—"}</div>
                      {r.errors.length > 0 && <div style={{ fontSize: 11.5, color: "#D70015", marginTop: 4 }}><AlertCircle size={12} style={{ verticalAlign: "middle" }} /> {r.errors.join(" · ")}</div>}
                      {r.duplicate && r.errors.length === 0 && (
                        <div style={{ fontSize: 11.5, color: "#C93400", marginTop: 4 }}><AlertCircle size={12} style={{ verticalAlign: "middle" }} /> Looks like an existing student{skipDuplicates ? " — will be skipped" : ""}</div>
                      )}
                    </div>
                  ))}
                </div>
                <div style={{ display: "flex", gap: 8 }}>
                  <button className="btn btn-ghost" style={{ flex: 1, justifyContent: "center" }} onClick={() => setImportRows(null)}>Choose different file</button>
                  <button className="btn btn-primary" style={{ flex: 1, justifyContent: "center" }} onClick={confirmImport}><Check size={15} /> Import valid rows</button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {historyStudent && (
        <div className="modal-backdrop" onClick={() => setHistoryStudent(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 420 }}>
            <div className="modal-head"><div className="modal-title">Payment history</div><button className="icon-btn" onClick={() => setHistoryStudent(null)}><X size={16} /></button></div>
            <p style={{ fontSize: 13, color: "#6E6E73", marginBottom: 12 }}>{historyStudent.name} · {money(historyStudent.paid)} paid of {money(historyStudent.total)}</p>
            {(historyStudent.payments || []).slice().reverse().map((p, i) => (
              <div className="history-item" key={i}><div className="history-top"><span className="mono">{money(p.amount)}</span><span className="history-time">{new Date(p.date).toLocaleString()}</span></div></div>
            ))}
            {(historyStudent.payments || []).length === 0 && <p style={{ fontSize: 12.5, color: "#86868B" }}>No payments logged yet.</p>}

            {(historyStudent.history || []).filter((h) => h.field !== "created").length > 0 && (
              <>
                <div className="report-section-label" style={{ marginTop: 18 }}>Changes</div>
                {historyStudent.history.filter((h) => h.field !== "created").slice().reverse().map((h, i) => (
                  <div className="history-item" key={i}>
                    <div className="history-top">
                      <span>{h.field}: <span className="mono">{String(h.oldValue ?? "—")}</span> → <span className="mono">{String(h.newValue ?? "—")}</span></span>
                      <span className="history-time">{new Date(h.at).toLocaleString()}</span>
                    </div>
                    <div style={{ fontSize: 11.5, color: "#86868B", marginTop: 2 }}>by {h.by}</div>
                  </div>
                ))}
              </>
            )}
          </div>
        </div>
      )}

      {payModal && (
        <div className="modal-backdrop" onClick={() => setPayModal(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 380 }}>
            <div className="modal-head"><div className="modal-title">Record payment</div><button className="icon-btn" onClick={() => setPayModal(null)}><X size={16} /></button></div>
            <p style={{ fontSize: 13, marginBottom: 12 }}>{payModal.name} owes <strong>{money(payModal.total - payModal.paid)}</strong>.</p>
            <PaymentForm student={payModal} onSubmit={(amt) => recordPayment(payModal.id, amt)} />
          </div>
        </div>
      )}

      {scheduleStudent && (
        <div className="modal-backdrop" onClick={() => setScheduleStudentId(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 440 }}>
            <div className="modal-head">
              <div className="modal-title">Payment schedule</div>
              <button className="icon-btn" onClick={() => setScheduleStudentId(null)}><X size={16} /></button>
            </div>
            <p style={{ fontSize: 13, color: "#6E6E73", marginBottom: 4 }}>
              {scheduleStudent.name} · {planLabel(scheduleStudent)}
            </p>
            <p style={{ fontSize: 13, marginBottom: 12 }}>
              <strong>{money(scheduleStudent.paid)}</strong> paid of {money(scheduleStudent.total)}
            </p>
            <div style={{ maxHeight: 340, overflow: "auto", marginBottom: 12 }}>
              {(scheduleStudent.installments || []).map((inst) => (
                <div key={inst.period} className="reminder-item" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
                  <div>
                    <div style={{ fontWeight: 600, fontSize: 13.5 }}>{inst.period}</div>
                    <div style={{ fontSize: 12, color: "#86868B" }}>
                      {money(inst.amount)} · Due {inst.due}
                      {inst.paid && inst.paidDate && <span> · Paid {new Date(inst.paidDate).toLocaleDateString()}</span>}
                    </div>
                  </div>
                  {inst.paid ? (
                    <span className="stamp" style={{ color: STATUS_META.paid.color, borderColor: STATUS_META.paid.color, background: STATUS_META.paid.bg }}>
                      <Check size={12} strokeWidth={2.5} /> Paid
                    </span>
                  ) : (
                    <button className="btn btn-primary" onClick={() => markInstallmentPaid(scheduleStudent.id, inst.period)}>
                      <Check size={14} /> Mark paid
                    </button>
                  )}
                </div>
              ))}
            </div>
            <button className="btn btn-ghost" style={{ width: "100%", justifyContent: "center" }} onClick={() => regenerateSchedule(scheduleStudent.id)}>
              Regenerate schedule
            </button>
          </div>
        </div>
      )}

      {showReminderPanel && (
        <div className="modal-backdrop" onClick={() => setShowReminderPanel(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head"><div className="modal-title">Send WhatsApp reminders</div><button className="icon-btn" onClick={() => setShowReminderPanel(false)}><X size={16} /></button></div>
            {unpaidSelectable.map((s) => (
              <div className="reminder-item" key={s.id}>
                <label>
                  <input type="checkbox" className="checkbox" checked={selected.has(s.id)} onChange={() => toggleSelect(s.id)} />
                  <div style={{ flex: 1 }}>
                    <div style={{ display: "flex", justifyContent: "space-between" }}>
                      <div style={{ fontWeight: 600, fontSize: 13.5 }}>{s.name} <span style={{ color: "#86868B", fontWeight: 400 }}>· {s.phone || "no number"}</span></div>
                      {s.phone && <a href={waLink(s.phone, defaultTemplate(s))} target="_blank" rel="noreferrer" onClick={(e) => { e.stopPropagation(); logSingleReminder(s); }} className="icon-btn" style={{ background: "#25D366", color: "#fff" }}><MessageCircle size={13} /></a>}
                    </div>
                    <div className="reminder-msg">{defaultTemplate(s)}</div>
                  </div>
                </label>
              </div>
            ))}
            <button className="btn btn-whatsapp" style={{ width: "100%", justifyContent: "center", marginTop: 10 }} onClick={sendReminders}><Send size={15} /> Log {selected.size} as sent</button>
          </div>
        </div>
      )}

      {showHistory && (
        <div className="modal-backdrop" onClick={() => setShowHistory(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head"><div className="modal-title">Reminder history</div><button className="icon-btn" onClick={() => setShowHistory(false)}><X size={16} /></button></div>
            {reminders.map((r) => (
              <div className="history-item" key={r.id}><div className="history-top"><span>{r.name}</span><span className="history-time">{new Date(r.sentAt).toLocaleString()}</span></div><div className="history-msg">{r.message}</div></div>
            ))}
          </div>
        </div>
      )}

      {showReports && (
        <div className="modal-backdrop" onClick={() => setShowReports(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 560 }}>
            <div className="modal-head"><div className="modal-title">Reports</div><button className="icon-btn" onClick={() => setShowReports(false)}><X size={16} /></button></div>
            <p style={{ fontSize: 12, color: "#86868B", marginBottom: 14 }}>Scoped to {schoolFilter}.</p>

            <div className="report-section-label">Collected — last 6 months</div>
            <div className="bar-chart">
              {monthlySeries.map((m) => {
                const max = Math.max(1, ...monthlySeries.map((x) => x.amount));
                const h = Math.round((m.amount / max) * 100);
                return (
                  <div className="bar-col" key={m.key}>
                    <div className="bar-value mono">{m.amount > 0 ? money(m.amount) : ""}</div>
                    <div className="bar-track"><div className="bar-fill" style={{ height: `${h}%` }} /></div>
                    <div className="bar-label">{m.label}</div>
                  </div>
                );
              })}
            </div>

            <div className="report-section-label" style={{ marginTop: 18 }}>
              {schoolFilter === "All Schools" ? "By school / class" : "By class"}
            </div>
            <div style={{ maxHeight: 260, overflow: "auto" }}>
              <table className="report-table">
                <thead><tr><th>{schoolFilter === "All Schools" ? "School · Class" : "Class"}</th><th>Students</th><th>Collected</th><th>Total fees</th></tr></thead>
                <tbody>
                  {classBreakdown.map((g) => (
                    <tr key={g.key}>
                      <td>{g.key}</td>
                      <td className="mono">{g.count}</td>
                      <td className="mono">{money(g.collected)}</td>
                      <td className="mono">{money(g.total)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {showBackup && (
        <div className="modal-backdrop" onClick={() => setShowBackup(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 420 }}>
            <div className="modal-head"><div className="modal-title">Backup &amp; restore</div><button className="icon-btn" onClick={() => setShowBackup(false)}><X size={16} /></button></div>
            <p style={{ fontSize: 12.5, color: "#6E6E73", marginBottom: 14, lineHeight: 1.5 }}>
              A safety net in case the server's storage ever resets. Download a full backup regularly, and keep the file somewhere safe (email to yourself, Google Drive, etc).
            </p>
            <button className="btn btn-primary" style={{ width: "100%", justifyContent: "center", marginBottom: 10 }} onClick={downloadBackup}>
              <Download size={15} /> Download backup (.json)
            </button>
            <div style={{ borderTop: "1px solid var(--line)", margin: "14px 0" }} />
            <p style={{ fontSize: 12.5, color: "#6E6E73", marginBottom: 10, lineHeight: 1.5 }}>
              Restoring will overwrite current data for your school(s) with what's in the file. Use this only if data has actually been lost.
            </p>
            <label className="btn btn-ghost" style={{ width: "100%", justifyContent: "center", cursor: "pointer" }}>
              <Upload size={15} /> Restore from backup file
              <input ref={backupFileRef} type="file" accept=".json" style={{ display: "none" }} onChange={handleBackupFileSelect} />
            </label>

            {!user.schools && (
              <>
                <div style={{ borderTop: "1px solid var(--line)", margin: "14px 0" }} />
                <div className="report-section-label">Automatic snapshots</div>
                <p style={{ fontSize: 11.5, color: "#86868B", marginBottom: 10, lineHeight: 1.4 }}>
                  Taken once a day automatically, plus right before any restore — a fallback even if no one remembers to click Download.
                </p>
                {snapshots === null && <p style={{ fontSize: 12.5, color: "#86868B" }}>Loading…</p>}
                {snapshots && snapshots.length === 0 && <p style={{ fontSize: 12.5, color: "#86868B" }}>No snapshots yet — the first automatic one is taken next time the app loads.</p>}
                <div style={{ maxHeight: 220, overflow: "auto" }}>
                  {(snapshots || []).map((snap) => (
                    <div key={snap.id} className="reminder-item" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
                      <div>
                        <div style={{ fontSize: 12.5, fontWeight: 600 }}>{new Date(snap.taken_at).toLocaleString()}</div>
                        <div style={{ fontSize: 11, color: "#86868B" }}>{snap.reason === "pre-restore" ? "Before a restore" : "Daily"} · {snap.student_count} students</div>
                      </div>
                      <div style={{ display: "flex", gap: 6 }}>
                        <a className="icon-btn" title="Download this snapshot" href={api.getSnapshotDownloadUrl(snap.id)} target="_blank" rel="noreferrer"><Download size={13} /></a>
                        <button className="icon-btn" title="Restore this snapshot" onClick={() => restoreFromSnapshot(snap)}><History size={13} /></button>
                      </div>
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {toast && (
        <div className={`toast ${toast.kind === "warn" ? "warn" : ""}`}>
          {toast.kind === "warn" ? <AlertTriangle size={15} /> : <Check size={15} />}
          {toast.text}
          {toast.action && (
            <button className="toast-action" onClick={() => { toast.action.onClick(); setToast(null); }}>{toast.action.label}</button>
          )}
        </div>
      )}
    </div>
  );
}

function PaymentForm({ student, onSubmit }) {
  const [amt, setAmt] = useState(student.total - student.paid);
  return (
    <div>
      <div className="field"><label>Amount received (₹)</label><input type="number" value={amt} onChange={(e) => setAmt(Number(e.target.value))} /></div>
      <button className="btn btn-primary" style={{ width: "100%", justifyContent: "center" }} onClick={() => onSubmit(amt)}><Check size={15} /> Record {amt ? money(amt) : "payment"}</button>
    </div>
  );
}
