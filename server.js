require('dotenv').config();
const path = require('path');
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { makeStore } = require('./store');

const PORT = process.env.PORT || 3000;
const SECRET = process.env.JWT_SECRET || 'dev-only-change-me';
if (!process.env.JWT_SECRET) console.warn('WARNING: JWT_SECRET is not set. Set it in .env before going live.');

let store;
let REV = Date.now(); // changes whenever any data is written; clients poll it

// collections that hold lists of records (one document per record)
const ARR = ['students', 'teachers', 'pay', 'leaves', 'lib', 'sched', 'hw', 'tests', 'tres', 'notices'];
const tk = (r) => `${r.tid}|${r.sid}|${r.sub || ''}`;
const keyOf = (col, item) => (col === 'tres' ? tk(item) : String(item.id));
const deny = () => { const e = new Error('Not allowed'); e.deny = true; throw e; };
const noPass = (d) => { const { _id, pass, ...rest } = d; return rest; };
const noId = (d) => { const { _id, ...rest } = d; return rest; };

// ---------- reading ----------
async function listArr(c) { return (await store.all(c)).map(noPass); }
async function readMap(c) { const o = {}; for (const d of await store.all(c)) o[d._id] = d.v; return o; }
async function meta(n, def) { const d = await store.get('meta', n); return d ? d.v : def; }

async function buildData(u) {
  const [students, teachers, pay, leaves, lib, sched, hw, tests, tres, notices] = await Promise.all(ARR.map(listArr));
  const att = await readMap('att'), fees = await readMap('fees'), sbc = await readMap('sbc');
  const adm = await store.get('meta', 'admin');
  const base = {
    admin: { id: adm ? adm.v.id : '' },
    classes: await meta('classes', []), subjects: await meta('subjects', []),
    sbc, fineRate: await meta('fineRate', 5), marks: [],
  };
  if (u.role === 'admin') return { ...base, students, teachers, att, fees, pay, leaves, lib, sched, hw, tests, tres, notices };
  if (u.role === 'teacher') {
    return {
      ...base, students, teachers: teachers.map(({ id, name, subject }) => ({ id, name, subject })),
      att, fees, pay: [], leaves, lib, sched, hw, tests, tres, notices,
    };
  }
  // student: only their own records plus class-level information
  const me = students.find((s) => s.id === u.id);
  const cls = me ? me.cls : '';
  const ownAtt = {};
  Object.keys(att).forEach((k) => { if (k.split('|')[1] === u.id) ownAtt[k] = att[k]; });
  return {
    ...base, students: me ? [me] : [], teachers: [], att: ownAtt,
    fees: fees[u.id] ? { [u.id]: fees[u.id] } : {},
    pay: pay.filter((x) => x.sid === u.id), leaves: leaves.filter((x) => x.sid === u.id),
    lib: lib.filter((x) => x.sid === u.id), sched: sched.filter((x) => x.cls === cls),
    hw: hw.filter((x) => x.cls === cls), tests: tests.filter((x) => x.cls === cls),
    tres: tres.filter((x) => x.sid === u.id), notices,
  };
}

// ---------- auth ----------
const fails = new Map();
const limited = (ip) => { const now = Date.now(); const a = (fails.get(ip) || []).filter((t) => now - t < 600000); fails.set(ip, a); return a.length >= 20; };
const failed = (ip) => { const a = fails.get(ip) || []; a.push(Date.now()); fails.set(ip, a); };
const sign = (u) => jwt.sign({ role: u.role, id: u.id }, SECRET, { expiresIn: '7d' });

async function auth(req, res, next) {
  try {
    const h = req.headers.authorization || '';
    const p = jwt.verify(h.startsWith('Bearer ') ? h.slice(7) : '', SECRET);
    let u = null;
    if (p.role === 'admin') {
      const a = await store.get('meta', 'admin');
      if (a && a.v.id.toLowerCase() === String(p.id).toLowerCase()) u = { role: 'admin', id: a.v.id, name: 'Administrator' };
    } else if (p.role === 'teacher' || p.role === 'student') {
      const d = await store.get(p.role === 'teacher' ? 'teachers' : 'students', String(p.id));
      if (d) u = { role: p.role, id: d.id, name: d.name, subject: d.subject };
    }
    if (!u) return res.status(401).json({ error: 'Session expired. Please sign in again.' });
    req.user = u;
    next();
  } catch (e) {
    res.status(401).json({ error: 'Please sign in.' });
  }
}

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '25mb' }));

app.post('/api/login', async (req, res) => {
  const ip = req.ip;
  if (limited(ip)) return res.status(429).json({ error: 'Too many attempts. Try again in a few minutes.' });
  const { role, id, password } = req.body || {};
  let user = null;
  try {
    if (typeof id === 'string' && typeof password === 'string') {
      const want = id.trim().toLowerCase();
      if (role === 'admin') {
        const a = await store.get('meta', 'admin');
        if (a && a.v.id.toLowerCase() === want && (await bcrypt.compare(password, a.v.hash))) user = { role, id: a.v.id, name: 'Administrator' };
      } else if (role === 'teacher' || role === 'student') {
        const d = (await store.all(role === 'teacher' ? 'teachers' : 'students')).find((x) => String(x.id).toLowerCase() === want);
        if (d && d.pass && (await bcrypt.compare(password, d.pass))) user = { role, id: d.id, name: d.name, subject: d.subject };
      }
    }
  } catch (e) { console.error(e); return res.status(500).json({ error: 'Server error' }); }
  if (!user) { failed(ip); return res.status(401).json({ error: 'Wrong ID or password' }); }
  res.json({ token: sign(user), user, rev: REV, data: await buildData(user) });
});

app.get('/api/me', auth, async (req, res) => {
  res.json({ user: req.user, rev: REV, data: await buildData(req.user) });
});
app.get('/api/version', auth, (req, res) => res.json({ rev: REV }));
app.get('/api/data', auth, async (req, res) => res.json({ data: await buildData(req.user) }));

// ---------- writing ----------
async function renameStudent(o, n) {
  if (!o || !n || o === n) return;
  const st = await store.get('students', o);
  if (!st || (await store.get('students', n))) return;
  const r = noId(st); r.id = n;
  await store.put('students', n, r); await store.del('students', o);
  const f = await store.get('fees', o);
  if (f) { await store.put('fees', n, f); await store.del('fees', o); }
  for (const d of await store.all('att')) {
    const p = d._id.split('|');
    if (p[1] === o) { p[1] = n; await store.put('att', p.join('|'), { v: d.v }); await store.del('att', d._id); }
  }
  for (const c of ['pay', 'leaves', 'lib']) {
    for (const d of await store.all(c)) if (d.sid === o) { const x = noId(d); x.sid = n; await store.put(c, d._id, x); }
  }
  for (const d of await store.all('tres')) {
    if (d.sid === o) { const x = noId(d); x.sid = n; await store.put('tres', tk(x), x); await store.del('tres', d._id); }
  }
}

async function applyArr(u, col, ch) {
  const role = u.role;
  const can = { admin: ARR, teacher: ['sched', 'hw', 'notices', 'tests', 'tres', 'leaves'], student: ['pay', 'leaves'] }[role] || [];
  if (!can.includes(col)) deny();
  for (const raw of ch.upsert || []) {
    if (!raw || typeof raw !== 'object') continue;
    const item = noId(raw);
    const key = keyOf(col, item);
    if (!key || key.includes('undefined')) continue;
    const old = await store.get(col, key);
    if (role === 'teacher') {
      if (col === 'notices') { if (item.by !== u.name || (old && old.by !== u.name)) deny(); }
      else if (col === 'tests') { if (item.kind === 'Final Exam' || (old && old.kind === 'Final Exam')) deny(); }
      else if (col === 'tres') { const t = await store.get('tests', String(item.tid)); if (!t || t.kind === 'Final Exam') deny(); }
      else if (col === 'leaves') {
        if (!old || !['Approved', 'Rejected'].includes(item.status)) deny();
        await store.put(col, key, { ...noId(old), status: item.status, remark: String(item.remark || '').slice(0, 300), by: `${u.name} (teacher)` });
        continue;
      }
    }
    if (role === 'student') {
      if (old) deny();
      if (col === 'pay') {
        const f = await store.get('fees', u.id);
        const pend = f ? Math.max(0, f.v.total - f.v.paid) : 0;
        const amt = Math.floor(Number(item.amt));
        if (item.sid !== u.id || item.status !== 'Pending' || !(amt >= 1) || amt > pend) deny();
        const shot = typeof item.shot === 'string' && item.shot.length < 3000000 ? item.shot : null;
        await store.put(col, key, { id: item.id, sid: u.id, amt, method: 'UPI', utr: String(item.utr || '').slice(0, 40), shot, status: 'Pending', date: String(item.date || '') });
        continue;
      }
      if (col === 'leaves') {
        if (item.sid !== u.id || item.status !== 'Pending') deny();
        await store.put(col, key, { id: item.id, sid: u.id, from: item.from, to: item.to, reason: String(item.reason || '').slice(0, 1000), status: 'Pending', remark: '', by: '', date: String(item.date || '') });
        continue;
      }
    }
    if (col === 'students' || col === 'teachers') {
      if (!item.id || typeof item.id !== 'string' || !item.name) continue;
      if (typeof item.pass === 'string' && item.pass) item.pass = await bcrypt.hash(item.pass, 10);
      else item.pass = old && old.pass ? old.pass : await bcrypt.hash(col === 'students' ? 'stud123' : 'teach123', 10);
    }
    await store.put(col, key, item);
  }
  for (const k of ch.remove || []) {
    const key = String(k);
    const old = await store.get(col, key);
    if (!old) continue;
    if (role === 'teacher') {
      if (col === 'notices') { if (old.by !== u.name) deny(); }
      else if (col === 'tres') { const t = await store.get('tests', String(old.tid)); if (!t || t.kind === 'Final Exam') deny(); }
      else if (col === 'tests' || col === 'leaves') deny();
    }
    if (role === 'student') deny();
    await store.del(col, key);
  }
}

async function applyMap(u, col, ch) {
  const ok = col === 'att' ? u.role === 'admin' || u.role === 'teacher' : u.role === 'admin';
  if (!ok) deny();
  for (const [k, v] of Object.entries(ch.set || {})) {
    if (col === 'att' && !(/^\d{4}-\d{2}-\d{2}\|/.test(k) && (v === 'P' || v === 'A'))) continue;
    await store.put(col, k, { v });
  }
  for (const k of ch.del || []) await store.del(col, String(k));
}

app.post('/api/sync', auth, async (req, res) => {
  const { renames = [], changes = {} } = req.body || {};
  const u = req.user, rejected = [];
  try {
    if (u.role === 'admin') for (const [o, n] of renames) await renameStudent(String(o), String(n));
    for (const col of Object.keys(changes)) {
      try {
        const ch = changes[col] || {};
        if (ARR.includes(col)) await applyArr(u, col, ch);
        else if (['att', 'fees', 'sbc'].includes(col)) await applyMap(u, col, ch);
        else if (['classes', 'subjects', 'fineRate'].includes(col)) { if (u.role !== 'admin') deny(); await store.put('meta', col, { v: ch.value }); }
        else deny();
      } catch (e) { if (e.deny) rejected.push(col); else throw e; }
    }
  } catch (e) { console.error(e); return res.status(500).json({ error: 'Server error while saving' }); }
  const prev = REV; REV = Math.max(REV + 1, Date.now());
  res.json({ ok: true, rejected, prev, rev: REV });
});

app.post('/api/account', auth, async (req, res) => {
  const { current, newPass, newId } = req.body || {};
  const u = req.user;
  if (typeof current !== 'string') return res.status(400).json({ error: 'Enter your current password.' });
  if (newPass && String(newPass).length < 4) return res.status(400).json({ error: 'New password must be at least 4 characters.' });
  let id = u.id;
  if (u.role === 'admin') {
    const a = await store.get('meta', 'admin');
    if (!(await bcrypt.compare(current, a.v.hash))) return res.status(400).json({ error: 'Current password is wrong.' });
    id = String(newId || a.v.id).trim();
    if (!id) return res.status(400).json({ error: 'Login ID cannot be empty.' });
    await store.put('meta', 'admin', { v: { id, hash: newPass ? await bcrypt.hash(String(newPass), 10) : a.v.hash } });
  } else {
    const col = u.role === 'teacher' ? 'teachers' : 'students';
    const d = await store.get(col, u.id);
    if (!(await bcrypt.compare(current, d.pass))) return res.status(400).json({ error: 'Current password is wrong.' });
    if (newPass) { const x = noId(d); x.pass = await bcrypt.hash(String(newPass), 10); await store.put(col, u.id, x); }
  }
  REV = Math.max(REV + 1, Date.now());
  res.json({ id, token: sign({ role: u.role, id }) });
});

app.get('/api/health', (req, res) => res.json({ ok: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use((err, req, res, next) => res.status(err.status || 500).json({ error: err.message || 'Server error' })); // eslint-disable-line

// ---------- first-run data ----------
async function seed() {
  if (await store.get('meta', 'seeded')) return;
  const h = (p) => bcrypt.hash(p, 10);
  await store.put('meta', 'admin', { v: { id: process.env.ADMIN_ID || 'mdjaseem7274', hash: await h(process.env.ADMIN_PASSWORD || 'mdjaseem7274@') } });
  await store.put('teachers', 'guddu7274', { id: 'guddu7274', name: 'Guddu', subject: 'Maths', pass: await h('guddu7274@') });
  const S = [
    ['3240002', 'Manish Kumar', 'Class 12', 1, '012', 'Kamal Singh', 'Sunil Kumari', '2006-12-08', 'manish123@gmail.com', 'Greater Noida'],
    ['3240446', 'Monika', 'Class 12', 2, '0123', 'Gangadhar', 'Anita', '2002-08-07', 'monikadwivedi76@gmail.com', 'Greater Noida'],
    ['3240447', 'Shruti', 'Class 12', 3, '01234', 'Gangadhar', 'Anita', '2006-07-04', 'shruti123@gmail.com', 'Greater Noida'],
    ['3240448', 'Somya', 'Class 11', 1, '012345', 'Balendea Kumar', 'Nirmal Devi', '2007-04-27', 'somya123@gmail.com', 'Delhi'],
    ['3240449', 'Gautam Singh', 'Class 10', 1, '0123456', 'Ram Baboo', 'Sunita Kumari', '2009-12-08', 'gautamkumar123@gmail.com', 'Muzaffarpur, Bihar'],
    ['32404450', 'Mohd Afzal', 'Class 9', 1, '01234567', 'Mohd Ibran', 'Zainab', '2010-12-08', 'afzal123@gmail.com', 'Lucknow'],
  ];
  for (const [id, name, cls, roll, pw, father, mother, dob, email, address] of S) {
    await store.put('students', id, { id, name, cls, roll, pass: await h(pw), father, mother, dob, phone: '987654321', email, address });
    await store.put('fees', id, { v: { total: 0, paid: 0 } });
  }
  const sub5 = ['English', 'Hindi', 'Maths', 'Science', 'Social Science'];
  const sub11 = ['English', 'Maths', 'Physics', 'Chemistry', 'Computer Science'];
  await store.put('meta', 'classes', { v: ['Class 9', 'Class 10', 'Class 11', 'Class 12'] });
  await store.put('meta', 'subjects', { v: ['English', 'Hindi', 'Maths', 'Science', 'Social Science', 'Physics', 'Chemistry', 'Computer Science'] });
  await store.put('sbc', 'Class 9', { v: sub5 }); await store.put('sbc', 'Class 10', { v: sub5 });
  await store.put('sbc', 'Class 11', { v: sub11 }); await store.put('sbc', 'Class 12', { v: sub11 });
  await store.put('meta', 'fineRate', { v: 5 });
  const today = new Date().toISOString().slice(0, 10);
  await store.put('notices', '1', { id: 1, title: 'Welcome', msg: 'Welcome to the Delhi Public School portal.', date: today, by: 'Principal', file: null });
  await store.put('meta', 'seeded', { v: true });
  console.log('First run: default admin, teacher and students created. Change their passwords after signing in.');
}

makeStore().then(async (s) => {
  store = s;
  await seed();
  app.listen(PORT, () => console.log(`School portal running on http://localhost:${PORT}`));
}).catch((e) => { console.error('Could not start:', e); process.exit(1); });
