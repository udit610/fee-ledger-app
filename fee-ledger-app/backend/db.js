// Lightweight JSON-file database. Good for a small school (hundreds of
// students, one or two admins). If you outgrow this later, swap the
// read()/write() functions below for a real database (Postgres, etc.)
// without touching any route code in server.js.

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.DB_PATH || path.join(__dirname, "data.json");

function read() {
  if (!fs.existsSync(DB_PATH)) {
    const initial = { students: [], reminders: [] };
    fs.writeFileSync(DB_PATH, JSON.stringify(initial, null, 2));
    return initial;
  }
  return JSON.parse(fs.readFileSync(DB_PATH, "utf-8"));
}

function write(data) {
  fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2));
}

export const db = {
  getStudents() {
    return read().students;
  },
  addStudent(student) {
    const data = read();
    data.students.unshift(student);
    write(data);
    return student;
  },
  updateStudent(id, patch) {
    const data = read();
    const idx = data.students.findIndex((s) => s.id === id);
    if (idx === -1) return null;
    data.students[idx] = { ...data.students[idx], ...patch };
    write(data);
    return data.students[idx];
  },
  addPayment(id, amount) {
    const data = read();
    const idx = data.students.findIndex((s) => s.id === id);
    if (idx === -1) return null;
    const s = data.students[idx];
    s.paid = Math.min(s.total, s.paid + amount);
    s.payments = [...(s.payments || []), { amount, date: new Date().toISOString() }];
    write(data);
    return s;
  },
  deleteStudent(id) {
    const data = read();
    data.students = data.students.filter((s) => s.id !== id);
    write(data);
  },
  bulkAddStudents(students) {
    const data = read();
    data.students = [...students, ...data.students];
    write(data);
    return students;
  },
  getReminders() {
    return read().reminders;
  },
  addReminder(reminder) {
    const data = read();
    data.reminders.unshift(reminder);
    write(data);
    return reminder;
  },
};
