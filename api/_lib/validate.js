/**
 * Server-side validation + sanitization.
 *
 * These mirror the client-side helpers in /assets/js/main.js. The client
 * sanitizes for UX (instant feedback) and to make the legitimate-user happy
 * path clean; the server sanitizes because the client is untrusted — anyone
 * can POST directly to /api/* with whatever shape they want.
 *
 * Every public function returns either a clean value or '' (empty string).
 * Callers check for required fields explicitly.
 */
const crypto = require('crypto');

// --- Email -----------------------------------------------------------------
// Same regex shape as the client, plus structural checks.
const EMAIL_REGEX = /^[A-Za-z0-9._%+\-]{1,64}@(?:[A-Za-z0-9](?:[A-Za-z0-9\-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,24}$/;
const DOTSEQ = /\.{2,}/;

function sanitizeEmail(v) {
  return String(v == null ? '' : v)
    .trim()
    .slice(0, 254)
    .replace(/[^A-Za-z0-9._%+\-@]/g, '');
}
function isPlausibleEmail(email) {
  if (!email || email.length > 254) return false;
  if (DOTSEQ.test(email)) return false;
  if (email.startsWith('.') || email.endsWith('.')) return false;
  if (email.includes('@.') || email.includes('.@')) return false;
  if ((email.match(/@/g) || []).length !== 1) return false;
  return EMAIL_REGEX.test(email);
}

// --- Source ----------------------------------------------------------------
// 'hero' or 'final' — the two waitlist forms on the page.
const VALID_SOURCES = new Set(['hero', 'final']);
function sanitizeSource(v) {
  const s = String(v == null ? '' : v).trim().toLowerCase().slice(0, 16);
  return VALID_SOURCES.has(s) ? s : '';
}

// --- Stage (chip) ----------------------------------------------------------
const VALID_STAGES = new Set([
  'University / college student',
  'Early career professional',
  'Mid-career professional',
  'Parent / family stage',
  'Retired',
]);
function sanitizeStage(v) {
  const s = String(v == null ? '' : v).trim().slice(0, 64);
  return VALID_STAGES.has(s) ? s : '';
}

// --- Likert scale (1-5) ----------------------------------------------------
const VALID_SCALE = new Set(['', '1', '2', '3', '4', '5']);
function sanitizeScale(v) {
  const s = String(v == null ? '' : v).trim();
  return VALID_SCALE.has(s) ? s : '';
}
function scaleToNumber(v) {
  const s = sanitizeScale(v);
  return s === '' ? null : parseInt(s, 10);
}

// --- Yes/No ----------------------------------------------------------------
const VALID_YESNO = new Set(['', 'Yes', 'No']);
function sanitizeYesNo(v) {
  const s = String(v == null ? '' : v).trim().slice(0, 8);
  return VALID_YESNO.has(s) ? s : '';
}

// --- Open-ended text -------------------------------------------------------
// Strips C0 controls (keeps \t \n), collapses runaway whitespace, caps at
// 2000 chars, and defuses spreadsheet formula injection on the off-chance
// the data ever ends up exported to a CSV/Sheets context.
function sanitizeText(v) {
  if (v == null) return '';
  let s = String(v);
  // eslint-disable-next-line no-control-regex
  s = s.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
  s = s.replace(/[ \t]{3,}/g, '  ');
  s = s.replace(/\n{4,}/g, '\n\n\n');
  s = s.trim().slice(0, 2000);
  if (s && /^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return s;
}

// --- Integer (dwell_ms etc.) -----------------------------------------------
function sanitizeInt(v, { min = 0, max = 86_400_000 } = {}) {
  const n = parseInt(String(v == null ? '' : v).trim(), 10);
  if (!Number.isFinite(n)) return null;
  if (n < min || n > max) return null;
  return n;
}

// --- IP hashing ------------------------------------------------------------
// Hash the client IP with a salt so we get abuse correlation (same IP, many
// submits) without storing plaintext PII. The salt MUST be set in env or
// every deploy produces uncorrelated hashes — which is annoying but safe.
function hashIp(ip) {
  const salt = process.env.IP_HASH_SALT;
  if (!salt || !ip) return null;
  return crypto.createHash('sha256').update(salt + '|' + ip).digest('hex').slice(0, 16);
}

// --- Request body parsing --------------------------------------------------
// Vercel parses application/json automatically into req.body. For
// application/x-www-form-urlencoded we fall back to manual parsing so the
// endpoint accepts either format (matches the original Apps Script behavior).
async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  const ct = String(req.headers['content-type'] || '').toLowerCase();
  if (!ct) return {};

  // Read the raw stream
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8');

  // Reject anything over 16 KB — the largest legitimate survey is ~3 KB.
  if (raw.length > 16 * 1024) throw new Error('payload too large');

  if (ct.includes('application/json')) {
    try { return JSON.parse(raw); } catch { return {}; }
  }
  if (ct.includes('application/x-www-form-urlencoded')) {
    const out = {};
    for (const [k, v] of new URLSearchParams(raw)) out[k] = v;
    return out;
  }
  return {};
}

// --- Client IP extraction --------------------------------------------------
// Vercel sets x-forwarded-for; trust the first entry (origin client IP).
function clientIp(req) {
  const xff = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return xff || req.socket?.remoteAddress || null;
}

module.exports = {
  sanitizeEmail, isPlausibleEmail,
  sanitizeSource, sanitizeStage,
  sanitizeScale, scaleToNumber,
  sanitizeYesNo, sanitizeText,
  sanitizeInt,
  hashIp, clientIp,
  readBody,
};
