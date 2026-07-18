// In production, VITE_API_URL should be left EMPTY so requests go to relative
// "/api/..." paths, which Vercel proxies to the real backend (see vercel.json).
// This keeps the session cookie same-site, avoiding browsers blocking it as
// a third-party cookie. For local dev, it falls back to localhost.
const API_URL = import.meta.env.VITE_API_URL || (import.meta.env.DEV ? "http://localhost:4000" : "");

async function request(path, options = {}) {
  const res = await fetch(`${API_URL}${path}`, {
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const err = new Error(body.error || `Request failed: ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

export const api = {
  me: () => request("/api/auth/me"),
  loginWithGoogle: (credential) => request("/api/auth/google", { method: "POST", body: JSON.stringify({ credential }) }),
  logout: () => request("/api/auth/logout", { method: "POST" }),

  getStudents: () => request("/api/students"),
  addStudent: (student) => request("/api/students", { method: "POST", body: JSON.stringify(student) }),
  updateStudent: (id, patch) => request(`/api/students/${id}`, { method: "PUT", body: JSON.stringify(patch) }),
  recordPayment: (id, amount) => request(`/api/students/${id}/payments`, { method: "POST", body: JSON.stringify({ amount }) }),
  deleteStudent: (id) => request(`/api/students/${id}`, { method: "DELETE" }),
  bulkImport: (students) => request("/api/students/bulk-import", { method: "POST", body: JSON.stringify({ students }) }),

  getReminders: () => request("/api/reminders"),
  logReminder: (entry) => request("/api/reminders", { method: "POST", body: JSON.stringify(entry) }),

  getBackup: () => request("/api/backup"),
  restoreBackup: (data) => request("/api/backup/restore", { method: "POST", body: JSON.stringify(data) }),
};
