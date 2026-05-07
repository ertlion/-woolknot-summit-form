'use strict';

const express = require('express');
const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const nodemailer = require('nodemailer');

const PORT          = parseInt(process.env.PORT, 10) || 3000;
const DATA_DIR      = process.env.DATA_DIR || path.join(__dirname, 'data');
const SUBMISSIONS   = path.join(DATA_DIR, 'submissions.json');
const STATE         = path.join(DATA_DIR, 'state.json');
const TOTAL_CAP     = parseInt(process.env.TOTAL_CAP, 10) || 20;

// --- Auth (email OTP) ---
const ADMIN_EMAIL    = process.env.ADMIN_EMAIL  || 'marketing@woolknot.com';
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const OTP_TTL_MS     = 10 * 60 * 1000;          // 10 min
const OTP_RATE_MS    = 60 * 1000;               // 1 send per minute

const SMTP_HOST = process.env.SMTP_HOST;
const SMTP_PORT = parseInt(process.env.SMTP_PORT || '465', 10);
const SMTP_USER = process.env.SMTP_USER;
const SMTP_PASS = process.env.SMTP_PASS;
const SMTP_FROM = process.env.SMTP_FROM || `Woolknot Admin <${ADMIN_EMAIL}>`;

let mailer = null;
if (SMTP_HOST && SMTP_USER && SMTP_PASS) {
  mailer = nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_PORT === 465,
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  });
}

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
// Auth — email OTP + signed session cookie
// ---------------------------------------------------------------------------
let currentOTP = null;     // { hash, expires }
let lastOTPSentAt = 0;     // for rate limit

function generateOTP() {
  return String(crypto.randomInt(100000, 1000000));
}

function hashOTP(code) {
  return crypto.createHmac('sha256', SESSION_SECRET).update(String(code)).digest('hex');
}

async function sendOTP(code) {
  const text = `Woolknot Admin · Giriş kodu: ${code}\n\nBu kod 10 dakika geçerlidir.\nGirişi siz başlatmadıysanız bu maili görmezden gelin.\n\nWoolknot`;
  const html = `<!doctype html><html><body style="font-family:-apple-system,BlinkMacSystemFont,sans-serif;background:#1A1612;color:#EDE4D5;padding:32px;margin:0">
    <div style="max-width:480px;margin:0 auto">
      <h1 style="font-family:Georgia,serif;font-weight:300;font-size:24px;margin:0 0 8px;color:#EDE4D5">Woolknot <span style="color:#B8885A;font-style:italic">Admin</span></h1>
      <p style="margin:0 0 24px;color:rgba(245,240,232,0.6);font-size:14px">Giriş kodunuz aşağıdadır.</p>
      <div style="background:#14110D;border:1px solid rgba(245,240,232,0.15);border-radius:4px;padding:24px;text-align:center;margin:24px 0">
        <div style="font-family:'Courier New',monospace;font-size:34px;letter-spacing:10px;color:#B8885A;font-weight:500">${code}</div>
      </div>
      <p style="margin:0;font-size:12px;color:rgba(245,240,232,0.45);line-height:1.6">Bu kod 10 dakika geçerlidir. Bu girişi siz başlatmadıysanız bu maili görmezden gelin.</p>
    </div>
  </body></html>`;

  if (mailer) {
    await mailer.sendMail({
      from: SMTP_FROM,
      to: ADMIN_EMAIL,
      subject: 'Woolknot Admin · Giriş Kodu',
      text, html,
    });
  } else {
    // No SMTP configured: log code to stdout. Visible in Coolify logs.
    console.warn('\n┌─────────────────────────────────────┐');
    console.warn('│  ADMIN OTP (no SMTP configured)     │');
    console.warn(`│  CODE: ${code}                        │`);
    console.warn(`│  Email target: ${ADMIN_EMAIL}`);
    console.warn('└─────────────────────────────────────┘\n');
  }
}

function signSession(payload) {
  const data = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(data).digest('base64url');
  return `${data}.${sig}`;
}

function verifySession(token) {
  if (!token || typeof token !== 'string') return null;
  const idx = token.indexOf('.');
  if (idx < 0) return null;
  const data = token.slice(0, idx);
  const sig  = token.slice(idx + 1);
  const expected = crypto.createHmac('sha256', SESSION_SECRET).update(data).digest('base64url');
  if (sig !== expected) return null;
  try {
    const obj = JSON.parse(Buffer.from(data, 'base64url').toString('utf8'));
    if (!obj || typeof obj.exp !== 'number' || obj.exp < Date.now()) return null;
    return obj;
  } catch { return null; }
}

function readCookie(req, name) {
  const raw = req.headers.cookie || '';
  for (const part of raw.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === name) return decodeURIComponent(rest.join('='));
  }
  return null;
}

function adminOnly(req, res, next) {
  const token = readCookie(req, 'wk_session');
  const session = verifySession(token);
  if (session && session.admin) return next();
  if (req.path.startsWith('/admin/api/')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  return res.redirect('/admin/login');
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
// Auth routes (login page + OTP send/verify + logout)
// ---------------------------------------------------------------------------
app.get('/admin/login', (req, res) => {
  // already logged in? bounce to /admin
  const session = verifySession(readCookie(req, 'wk_session'));
  if (session && session.admin) return res.redirect('/admin');
  res.sendFile(path.join(__dirname, 'views', 'login.html'));
});

app.post('/admin/auth/request', async (_req, res) => {
  const now = Date.now();
  if (now - lastOTPSentAt < OTP_RATE_MS) {
    const wait = Math.ceil((OTP_RATE_MS - (now - lastOTPSentAt)) / 1000);
    return res.status(429).json({ success: false, message: `${wait} sn sonra tekrar deneyin.` });
  }
  const code = generateOTP();
  currentOTP = { hash: hashOTP(code), expires: now + OTP_TTL_MS };
  lastOTPSentAt = now;
  try {
    await sendOTP(code);
  } catch (e) {
    console.error('OTP send error:', e.message);
    return res.status(500).json({ success: false, message: 'Mail gönderilemedi: ' + e.message });
  }
  // Mask email a bit for display
  const masked = ADMIN_EMAIL.replace(/^([^@]{1,3}).*?(@.+)$/, '$1***$2');
  res.json({ success: true, sentTo: masked, viaSmtp: !!mailer });
});

app.post('/admin/auth/verify', (req, res) => {
  const code = String((req.body && req.body.code) || '').trim();
  if (!code || !/^[0-9]{6}$/.test(code)) {
    return res.status(400).json({ success: false, message: '6 haneli kod giriniz.' });
  }
  if (!currentOTP) {
    return res.status(400).json({ success: false, message: 'Önce kod isteyin.' });
  }
  if (currentOTP.expires < Date.now()) {
    currentOTP = null;
    return res.status(400).json({ success: false, message: 'Kod süresi doldu, tekrar isteyin.' });
  }
  if (hashOTP(code) !== currentOTP.hash) {
    return res.status(400).json({ success: false, message: 'Hatalı kod.' });
  }
  currentOTP = null;
  const exp = Date.now() + SESSION_TTL_MS;
  const token = signSession({ admin: true, exp });
  const isHttps = req.secure || (req.headers['x-forwarded-proto'] === 'https');
  res.cookie('wk_session', token, {
    httpOnly: true,
    secure: isHttps,
    sameSite: 'lax',
    maxAge: SESSION_TTL_MS,
    path: '/',
  });
  res.json({ success: true, redirect: '/admin' });
});

app.post('/admin/logout', (_req, res) => {
  res.clearCookie('wk_session', { path: '/' });
  res.json({ success: true });
});

// ---------------------------------------------------------------------------
// Admin panel + API (cookie session)
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
    console.log(`  data dir : ${DATA_DIR}`);
    console.log(`  admin    : /admin (login: /admin/login, OTP via mail)`);
    console.log(`  admin email target: ${ADMIN_EMAIL}`);
    console.log(`  SMTP     : ${mailer ? `${SMTP_HOST}:${SMTP_PORT}` : 'NOT configured (codes will print here)'}`);
  });
});
