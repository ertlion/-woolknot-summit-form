'use strict';

const express = require('express');
const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const speakeasy = require('speakeasy');
const QRCode = require('qrcode');

const PORT          = parseInt(process.env.PORT, 10) || 3000;
const DATA_DIR      = process.env.DATA_DIR || path.join(__dirname, 'data');
const SUBMISSIONS   = path.join(DATA_DIR, 'submissions.json');
const STATE         = path.join(DATA_DIR, 'state.json');
const TOTAL_CAP     = parseInt(process.env.TOTAL_CAP, 10) || 20;

// --- Auth (TOTP / authenticator app) ---
const TOTP_LABEL     = process.env.TOTP_LABEL  || 'admin@woolknot.com';
const TOTP_ISSUER    = process.env.TOTP_ISSUER || 'Woolknot Admin';
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const VERIFY_RATE_MS = 1500;                    // throttle bad attempts

const FORMSUBMIT_URL = 'https://formsubmit.co/ajax/marketing@woolknot.com';
// Counter is stored in state.json (state.invitationCount). No external service.

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
// Auth — TOTP (RFC 6238) via Google Authenticator / Authy / 1Password / etc.
// ---------------------------------------------------------------------------
let lastBadAttemptAt = 0;

async function getTotpRecord() {
  const state = await readJSON(STATE, {});
  if (!state.totp || !state.totp.secret) {
    const generated = speakeasy.generateSecret({
      name: TOTP_LABEL,
      issuer: TOTP_ISSUER,
      length: 20,
    });
    state.totp = {
      secret: process.env.TOTP_SECRET || generated.base32,
      enrolled: false,
      createdAt: new Date().toISOString(),
    };
    await writeJSON(STATE, state);
    console.log('TOTP secret generated. Visit /admin/setup to enroll your authenticator app.');
  }
  return state.totp;
}

function totpUri(secret) {
  return speakeasy.otpauthURL({
    secret,
    label: TOTP_LABEL,
    issuer: TOTP_ISSUER,
    encoding: 'base32',
  });
}

function totpVerify(secret, token) {
  return speakeasy.totp.verify({
    secret,
    encoding: 'base32',
    token,
    window: 1,
  });
}

async function getInvitationCount() {
  const state = await readJSON(STATE, {});
  return Number.isFinite(state.invitationCount) ? state.invitationCount : 0;
}

async function setInvitationCount(value) {
  const v = Math.max(0, Math.floor(Number(value) || 0));
  const state = await readJSON(STATE, {});
  state.invitationCount = v;
  await writeJSON(STATE, state);
  return v;
}

async function bumpInvitationCount(delta) {
  const cur = await getInvitationCount();
  return setInvitationCount(cur + delta);
}

async function markEnrolled() {
  const state = await readJSON(STATE, {});
  if (state.totp) {
    state.totp.enrolled = true;
    state.totp.enrolledAt = new Date().toISOString();
    await writeJSON(STATE, state);
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
  const state = await readJSON(STATE, {});
  const value = Number.isFinite(state.invitationCount) ? state.invitationCount : 0;
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

  // 2) Increment local invitation counter
  bumpInvitationCount(1).catch(e => console.error('counter bump failed:', e.message));

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
// Auth routes (login + TOTP verify + setup + logout)
// ---------------------------------------------------------------------------
app.get('/admin/login', (req, res) => {
  const session = verifySession(readCookie(req, 'wk_session'));
  if (session && session.admin) return res.redirect('/admin');
  res.sendFile(path.join(__dirname, 'views', 'login.html'));
});

// Setup page — only available before first successful login (enrolment).
// Shows static setup.html which fetches /admin/setup/data for QR code + secret.
app.get('/admin/setup', async (_req, res) => {
  const totp = await getTotpRecord();
  if (totp.enrolled && process.env.ALLOW_REENROLL !== 'true') {
    return res.status(404).send('<h1>404 — Setup completed</h1><p>Re-enrolment is disabled. Set <code>ALLOW_REENROLL=true</code> env var to allow re-enrolment.</p>');
  }
  res.sendFile(path.join(__dirname, 'views', 'setup.html'));
});

// Setup data endpoint (consumed by setup.html)
app.get('/admin/setup/data', async (_req, res) => {
  const totp = await getTotpRecord();
  if (totp.enrolled && process.env.ALLOW_REENROLL !== 'true') {
    return res.status(404).json({ error: 'enrolled' });
  }
  const otpauth = totpUri(totp.secret);
  let qrDataUrl = '';
  try {
    qrDataUrl = await QRCode.toDataURL(otpauth, {
      width: 260, margin: 1,
      color: { dark: '#1A1612', light: '#EDE4D5' },
    });
  } catch (e) { /* ignore */ }
  res.json({
    secret: totp.secret,
    otpauth,
    qrDataUrl,
    issuer: TOTP_ISSUER,
    label: TOTP_LABEL,
  });
});

app.post('/admin/auth/verify', async (req, res) => {
  // basic throttle
  const now = Date.now();
  if (now - lastBadAttemptAt < VERIFY_RATE_MS) {
    return res.status(429).json({ success: false, message: 'Çok hızlı deneme, biraz bekleyin.' });
  }
  const code = String((req.body && req.body.code) || '').trim();
  if (!/^[0-9]{6}$/.test(code)) {
    return res.status(400).json({ success: false, message: '6 haneli kod giriniz.' });
  }
  const totp = await getTotpRecord();
  let ok = false;
  try {
    ok = totpVerify(totp.secret, code);
  } catch (e) {
    console.error('TOTP verify error:', e.message);
  }
  if (!ok) {
    lastBadAttemptAt = now;
    return res.status(400).json({ success: false, message: 'Hatalı kod. Authenticator app saatini kontrol edin.' });
  }
  if (!totp.enrolled) await markEnrolled();
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
  const state = await readJSON(STATE, {});
  const subs = await readJSON(SUBMISSIONS, []);
  const value = Number.isFinite(state.invitationCount) ? state.invitationCount : 0;
  res.json({
    // Keep `abacusValue` key for frontend compatibility
    abacusValue: value,
    submissionsCount: subs.length,
    total: TOTAL_CAP,
    forceFull: !!state.forceFull,
  });
});

app.post('/admin/api/counter', adminOnly, async (req, res) => {
  const { value, forceFull } = req.body || {};
  let newValue = null;

  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
    newValue = await setInvitationCount(value);
  }

  if (typeof forceFull === 'boolean') {
    const state = await readJSON(STATE, {});
    state.forceFull = forceFull;
    await writeJSON(STATE, state);
  }

  res.json({ success: true, abacusValue: newValue });
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
    console.log(`  admin    : /admin (login: /admin/login, TOTP via authenticator app)`);
    console.log(`  setup    : /admin/setup (one-time, scan QR with Google Authenticator/Authy)`);
  });
});
