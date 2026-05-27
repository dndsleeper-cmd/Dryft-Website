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
// Hyphen placed at the END of each character class so it's literal without
// needing to be escaped (ESLint flags the redundant backslash).
const EMAIL_REGEX =
  /^[A-Za-z0-9._%+-]{1,64}@(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,24}$/;
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
  const s = String(v == null ? '' : v)
    .trim()
    .toLowerCase()
    .slice(0, 16);
  return VALID_SOURCES.has(s) ? s : '';
}

// --- Career stage (chip) ---------------------------------------------------
// Kept as a Set so allowlist membership is O(1). Must match the data-value
// attributes in index.html exactly — including the en-dash in "0–2" etc.
const VALID_CAREER_STAGES = new Set([
  'High school student',
  'University / college student',
  'Recent graduate (0–2 years working)',
  'Early-career professional (3–7 years)',
  'Mid-career professional',
  'Senior professional / executive',
  'Self-employed / freelancer',
  'Founder / entrepreneur',
  'Between jobs',
  'Retired',
  'Prefer not to say',
]);
function sanitizeCareerStage(v) {
  const s = String(v == null ? '' : v)
    .trim()
    .slice(0, 64);
  return VALID_CAREER_STAGES.has(s) ? s : '';
}

// --- Life / family stage (chip) -------------------------------------------
const VALID_LIFE_STAGES = new Set([
  'Living with parents or family',
  'Living independently',
  'In a long-term relationship',
  'Married / partnered',
  'Parent with young children',
  'Parent with teenage or adult children',
  'Caring for family members',
  'Empty nester',
  'Retired',
  'Prefer not to say',
]);
function sanitizeLifeStage(v) {
  const s = String(v == null ? '' : v)
    .trim()
    .slice(0, 64);
  return VALID_LIFE_STAGES.has(s) ? s : '';
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
  const s = String(v == null ? '' : v)
    .trim()
    .slice(0, 8);
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
  return crypto
    .createHash('sha256')
    .update(salt + '|' + ip)
    .digest('hex')
    .slice(0, 16);
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
    try {
      return JSON.parse(raw);
    } catch {
      return {};
    }
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
  const xff = String(req.headers['x-forwarded-for'] || '')
    .split(',')[0]
    .trim();
  return xff || req.socket?.remoteAddress || null;
}

// --- reCAPTCHA v3 verification --------------------------------------------
// We use plain reCAPTCHA v3 (not Firebase App Check) because the site has
// no other Firebase Web SDK use — pulling in the Firebase JS bundle just to
// wrap reCAPTCHA would cost ~30 KB for marginal benefit.
//
// Behavior:
//   - If RECAPTCHA_SECRET_KEY is NOT set → verification is skipped entirely.
//     This lets the endpoint work in dev / before the secret is provisioned.
//   - If the secret IS set → token is required; missing or invalid → reject.
//     Score < 0.5 (Google's default suspicious threshold) → reject.
//
// Returns { ok: true, score? } or { ok: false, reason, score? }.
async function verifyRecaptcha(token, ip) {
  const secret = process.env.RECAPTCHA_SECRET_KEY;
  if (!secret) return { ok: true, skipped: true };
  if (!token) return { ok: false, reason: 'missing-token' };

  const params = new URLSearchParams();
  params.set('secret', secret);
  params.set('response', String(token).slice(0, 4096));
  if (ip) params.set('remoteip', ip);

  let data;
  try {
    const resp = await fetch('https://www.google.com/recaptcha/api/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params,
      signal: AbortSignal.timeout(4000),
    });
    data = await resp.json();
  } catch (err) {
    // If Google is unreachable, fail OPEN — better to accept a real signup
    // than to lose data because of a transient outage. The rate limiter
    // still applies as a backstop.
    console.warn('[recaptcha] siteverify unreachable:', err && err.message);
    return { ok: true, degraded: true };
  }

  if (!data || !data.success) {
    return { ok: false, reason: 'failed', errors: data && data['error-codes'] };
  }
  // v3 returns a score in [0, 1]. 1.0 = very likely human, 0.0 = very likely bot.
  if (typeof data.score === 'number' && data.score < 0.5) {
    return { ok: false, reason: 'low-score', score: data.score };
  }
  return { ok: true, score: data.score };
}

// --- Rate limiting --------------------------------------------------------
// Tries Upstash Redis (durable, distributed across serverless instances)
// first; falls back to an in-memory Map (works only on a warm instance, but
// catches the most common abuse pattern — same attacker, rapid bursts).
//
// Pattern: fixed-window counter. Each key gets INCR'd; on the first hit
// inside a fresh window, we set a TTL. Above `max` in the window → blocked.
//
// Returns { allowed: true } or { allowed: false, retryAfterMs }.
const _memCounters = new Map();

async function upstashFetch(pathSegments) {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  const resp = await fetch(url + '/' + pathSegments.map(encodeURIComponent).join('/'), {
    headers: { Authorization: 'Bearer ' + token },
    signal: AbortSignal.timeout(2000),
  });
  if (!resp.ok) throw new Error('upstash ' + resp.status);
  return resp.json();
}

async function rateLimit(key, { max = 5, windowSec = 60 } = {}) {
  // Try Upstash (real distributed rate limit) first.
  try {
    const incrRes = await upstashFetch(['incr', key]);
    if (incrRes && typeof incrRes.result === 'number') {
      // First hit in a fresh window — apply TTL.
      if (incrRes.result === 1) {
        await upstashFetch(['expire', key, String(windowSec)]).catch(() => {});
      }
      if (incrRes.result > max) {
        return { allowed: false, retryAfterMs: windowSec * 1000 };
      }
      return { allowed: true, source: 'upstash', count: incrRes.result };
    }
  } catch (err) {
    console.warn('[ratelimit] upstash unreachable:', err && err.message);
    // fall through to in-memory
  }

  // In-memory fallback (per warm instance).
  const now = Date.now();
  const windowMs = windowSec * 1000;
  const entry = _memCounters.get(key) || { count: 0, resetAt: now + windowMs };
  if (now > entry.resetAt) {
    entry.count = 0;
    entry.resetAt = now + windowMs;
  }
  entry.count++;
  _memCounters.set(key, entry);
  // Periodically prune expired entries so the map can't grow unbounded.
  if (_memCounters.size > 1000) {
    for (const [k, v] of _memCounters) if (now > v.resetAt) _memCounters.delete(k);
  }
  if (entry.count > max) {
    return { allowed: false, retryAfterMs: entry.resetAt - now, source: 'memory' };
  }
  return { allowed: true, source: 'memory', count: entry.count };
}

module.exports = {
  sanitizeEmail,
  isPlausibleEmail,
  sanitizeSource,
  sanitizeCareerStage,
  sanitizeLifeStage,
  sanitizeScale,
  scaleToNumber,
  sanitizeYesNo,
  sanitizeText,
  sanitizeInt,
  hashIp,
  clientIp,
  readBody,
  verifyRecaptcha,
  rateLimit,
};
