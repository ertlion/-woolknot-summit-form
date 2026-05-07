'use strict';

const express = require('express');
const fs = require('fs/promises');
const path = require('path');
const basicAuth = require('basic-auth');

const PORT          = parseInt(process.env.PORT, 10) || 3000;
const DATA_DIR      = process.env.DATA_DIR || path.join(__dirname, 'data');
const SUBMISSIONS   = path.join(DATA_DIR, 'submissions.json');
const STATE         = path.join(DATA_DIR, 'state.json');
const ADMIN_USER    = process.env.ADMIN_USER || 'admin';
const ADMIN_PASS    = process.env.ADMIN_PASS || 'woolknot-2026';
const TOTAL_CAP     = parseInt(process.env.TOTAL_CAP, 10) || 20;

const FORMSUBMIT_URL = 'https://formsubmit.co/ajax/marketing@woolknot.com';
const ABACUS_NS      = 'woolknot-summit-2026';
const ABACUS_KEY     = 'invitations';
const ABACUS_ADMIN   = process.env.ABACUS_ADMIN_KEY || '31612311-a71a-46b2-836c-cec35db771cb';
const ABACUS_GET     = `https://abacus.jasoncameron.dev/get/${ABACUS_NS}/${ABACUS_KEY}`;
const ABACUS_HIT     = `https://abacus.jasoncameron.dev/hit/${ABACUS_NS}/${ABACUS_KEY}`;
const ABACUS_SET     = (v) => `https://abacus.jasoncameron.dev/set/${ABACUS_NS}/${ABACUS_KEY}/${v}?admin_key=${ABACUS_ADMIN}`;

// ---------------------------------------------------------------------------
// File-backed JSON store with serialized writes (no race conditions)
// ---------------------------------------------------------------------------
let writeChain = Promise.resolve();

async function ensureDataDir() {
  await fs.mkdir(DATA_DIR, { recursive: true });
}

async function readJSON(file, fallback) {
  try {
    const raw = await fs.readFile(file, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    if (err.code !== 'ENOENT') console.error('readJSON error:', file, err.message);
    return fallback;
  }
}

function writeJSON(file, data) {
  writeChain = writeChain.then(async () => {
    await ensureDataDir();
    const tmp = file + '.tmp';
    await fs.writeFile(tmp, JSON.stringify(data, null, 2));
    await fs.rename(tmp, file);
  }).catch(err => {
    console.error('writeJSON error:', file, err.message);
  });
  return writeChain;
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------
function adminOnly(req, res, next) {
  const u = basicAuth(req);
  if (!u || u.name !== ADMIN_USER || u.pass !== ADMIN_PASS) {
    res.set('WWW-Authenticate', 'Basic realm="Woolknot Admin"');
    return res.status(401).send('Authentication required.');
  }
  next();
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------
const app = express();
app.disable('x-powered-by');
app.set('trust proxy', true);
app.use(express.json({ limit: '32kb' }));

// Static — only files inside ./public are exposed. admin.html lives in ./views and is gated below.
app.use(express.static(path.join(__dirname, 'public'), {
  index: 'index.html',
  extensions: ['html'],
  setHeaders: (res) => res.set('X-Content-Type-Options', 'nosniff'),
}));

// Health
app.get('/health', (_req, res) => res.type('text/plain').send('ok'));

// ---------------------------------------------------------------------------
// Public API: invitation status (used by frontend to render counter)
// ---------------------------------------------------------------------------
app.get('/api/status', async (_req, res) => {
  let value = 0;
  try {
    const r = await fetch(ABACUS_GET);
    if (r.ok) value = Number((await r.json()).value) || 0;
  } catch (e) { /* ignore */ }
  const state = await readJSON(STATE, { forceFull: false });
  const forceFull = !!state.forceFull;
  res.json({
    value,
    total: TOTAL_CAP,
    forceFull,
    effectiveCurrent: forceFull ? TOTAL_CAP : value,
  });
});

// ---------------------------------------------------------------------------
// Public API: form submission
// ---------------------------------------------------------------------------
app.post('/api/submit', async (req, res) => {
  const body = req.body || {};
  const fullname = (body.fullname || '').toString().trim().slice(0, 200);
  const email    = (body.email    || '').toString().trim().slice(0, 200);
  const phone    = (body.phone    || '').toString().trim().slice(0, 50);
  const company  = (body.company  || '').toString().trim().slice(0, 200);
  const interest = (body.interest || '').toString().trim().slice(0, 200);
  const source   = (body.source   || '').toString().trim().slice(0, 200);

  if (!fullname || !email || !phone) {
    return res.status(400).json({ success: false, message: 'Lütfen ad, e-posta ve telefon alanlarını doldurun.' });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ success: false, message: 'Geçerli bir e-posta giriniz.' });
  }

  const submission = {
    id: Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8),
    fullname, email, phone, company, interest, source,
    ip: (req.headers['x-forwarded-for'] || '').toString().split(',')[0].trim() || req.ip || '',
    userAgent: (req.headers['user-agent'] || '').toString().slice(0, 300),
    timestamp: new Date().toISOString(),
  };

  // 1) Persist locally (this is the source of truth for admin panel)
  try {
    const subs = await readJSON(SUBMISSIONS, []);
    subs.push(submission);
    await writeJSON(SUBMISSIONS, subs);
  } catch (e) {
    console.error('persist failed:', e.message);
  }

  // 2) Increment Abacus shared counter (silent fail)
  fetch(ABACUS_HIT).catch(() => {});

  // 3) Forward to FormSubmit for email backup (silent fail)
  forwardToFormSubmit(submission).catch(err =>
    console.warn('FormSubmit forward failed:', err.message)
  );

  res.json({ success: true });
});

async function forwardToFormSubmit(s) {
  const fd = new FormData();
  fd.append('fullname', s.fullname);
  fd.append('email', s.email);
  fd.append('phone', s.phone);
  fd.append('company', s.company);
  fd.append('interest', s.interest);
  fd.append('source', s.source);
  fd.append('_subject', 'Yeni Woolknot Topluluk Başvurusu');
  fd.append('_template', 'table');
  fd.append('_captcha', 'false');
  const r = await fetch(FORMSUBMIT_URL, {
    method: 'POST',
    body: fd,
    headers: { Accept: 'application/json' },
  });
  if (!r.ok) throw new Error('formsubmit ' + r.status);
}

// ---------------------------------------------------------------------------
// Admin panel + API (HTTP Basic Auth)
// ---------------------------------------------------------------------------
app.get('/admin', adminOnly, (_req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'admin.html'));
});

app.get('/admin/api/submissions', adminOnly, async (_req, res) => {
  const subs = await readJSON(SUBMISSIONS, []);
  // Latest first
  res.json(subs.slice().reverse());
});

app.delete('/admin/api/submissions/:id', adminOnly, async (req, res) => {
  const subs = await readJSON(SUBMISSIONS, []);
  const next = subs.filter(s => s.id !== req.params.id);
  await writeJSON(SUBMISSIONS, next);
  res.json({ success: true, removed: subs.length - next.length });
});

app.get('/admin/api/counter', adminOnly, async (_req, res) => {
  let abacusValue = null;
  try {
    const r = await fetch(ABACUS_GET);
    if (r.ok) abacusValue = Number((await r.json()).value) || 0;
  } catch (e) { /* ignore */ }
  const state = await readJSON(STATE, { forceFull: false });
  const subs = await readJSON(SUBMISSIONS, []);
  res.json({
    abacusValue,
    submissionsCount: subs.length,
    total: TOTAL_CAP,
    forceFull: !!state.forceFull,
  });
});

app.post('/admin/api/counter', adminOnly, async (req, res) => {
  const { value, forceFull } = req.body || {};
  let abacusValue = null;

  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
    try {
      const r = await fetch(ABACUS_SET(Math.floor(value)));
      if (r.ok) {
        const data = await r.json();
        abacusValue = Number(data.value) || 0;
      }
    } catch (e) {
      console.error('abacus set failed:', e.message);
    }
  }

  if (typeof forceFull === 'boolean') {
    const state = await readJSON(STATE, {});
    state.forceFull = forceFull;
    await writeJSON(STATE, state);
  }

  res.json({ success: true, abacusValue });
});

app.get('/admin/api/export.csv', adminOnly, async (_req, res) => {
  const subs = await readJSON(SUBMISSIONS, []);
  const cols = ['timestamp', 'fullname', 'email', 'phone', 'company', 'interest', 'source', 'ip'];
  const csvEscape = (v) => '"' + String(v ?? '').replace(/"/g, '""') + '"';
  const rows = subs.map(s => cols.map(c => csvEscape(s[c])).join(','));
  const csv = '﻿' + [cols.join(','), ...rows].join('\r\n');
  const fname = `woolknot-${new Date().toISOString().slice(0, 10)}.csv`;
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="${fname}"`);
  res.send(csv);
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
ensureDataDir().catch(() => {}).finally(() => {
  app.listen(PORT, () => {
    console.log(`Woolknot summit-form server running on :${PORT}`);
    console.log(`  data dir: ${DATA_DIR}`);
    console.log(`  admin   : /admin (basic auth)`);
  });
});
