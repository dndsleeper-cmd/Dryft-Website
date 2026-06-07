/**
 * Server-side validation + sanitization.
 *
 * These mirror the client-side helpers in /assets/js/main.js. The client
 * sanitizes for UX (instant feedback) and to make the legitimate-user happy
 * path clean; the server sanitizes because the client is untrusted, anyone
 * can POST directly to /api/* with whatever shape they want.
 *
 * Every public function returns either a clean value or '' (empty string).
 * Callers check for required fields explicitly.
 */
const crypto = require('crypto');

// --- Phone (SMS contact, E.164 / NANP) -------------------------------------
// We collect a mobile number for SMS instead of an email. The site offers
// Canada (+1) and the United States (+1), both in the North American
// Numbering Plan, so a valid number is +1 followed by a 10-digit NANP number
// whose area code and exchange code each start 2–9. Stored canonically as
// E.164 ("+14165550123"); the doc id is derived from this canonical form.
const NANP_REGEX = /^\+1[2-9]\d{2}[2-9]\d{6}$/;

// Normalize whatever the client sends, "+1 (416) 555-0123", "14165550123",
// "4165550123", to E.164. Strip everything except digits, assume +1 when the
// country code is absent (10-digit NANP), then prefix a single '+'.
function sanitizePhone(v) {
  let digits = String(v == null ? '' : v)
    .replace(/\D/g, '')
    .slice(0, 15);
  if (!digits) return '';
  if (digits.length === 10) digits = '1' + digits; // bare NANP → assume +1
  return '+' + digits;
}
function isPlausiblePhone(phone) {
  return NANP_REGEX.test(String(phone == null ? '' : phone));
}

// --- Region (country chosen in the dial-code dropdown) ----------------------
// Canada / United States, both +1, so this is stored for analytics, not for
// dialing. Must match the <option value> attributes in the forms.
const VALID_REGIONS = new Set(['CA', 'US']);
function sanitizeRegion(v) {
  const s = String(v == null ? '' : v)
    .trim()
    .toUpperCase()
    .slice(0, 2);
  return VALID_REGIONS.has(s) ? s : '';
}

// --- Source ----------------------------------------------------------------
// 'hero' / 'final', the two waitlist forms on the landing page.
// 'referral', the code+phone form on /referral.
const VALID_SOURCES = new Set(['hero', 'final', 'referral']);
function sanitizeSource(v) {
  const s = String(v == null ? '' : v)
    .trim()
    .toLowerCase()
    .slice(0, 16);
  return VALID_SOURCES.has(s) ? s : '';
}

// Traffic-source channel (first-touch), classified client-side from the
// referrer/UTM and sent on both the pageview ping and the signup. Whitelisted
// so a tampered value can't pollute the per-channel breakdown.
const VALID_CHANNELS = new Set(['Direct', 'Organic Search', 'Social', 'Referral', 'Other']);
function sanitizeChannel(v) {
  const s = String(v == null ? '' : v).trim().slice(0, 16);
  return VALID_CHANNELS.has(s) ? s : '';
}

// Hero A/B test bucket. Whitelisted single letter so a tampered value can't
// pollute the dashboard's per-variant breakdown.
const VALID_VARIANTS = new Set(['A', 'B']);
function sanitizeVariant(v) {
  const s = String(v == null ? '' : v)
    .trim()
    .toUpperCase()
    .slice(0, 1);
  return VALID_VARIANTS.has(s) ? s : '';
}

// --- Referral codes --------------------------------------------------------
// Codes are Crockford base32 (no I/L/O/U, unambiguous when read aloud or
// hand-typed). Generated deterministically from the canonical contact (the
// E.164 phone) so a given person always gets the same shareable code, and we
// can recompute it.
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const CROCKFORD_SET = new Set(CROCKFORD.split(''));

// 7 chars = 35 bits of the SHA-256 of the canonical contact (now the E.164
// phone) → ~34 billion-code space. Collision risk is negligible at beta scale;
// the mapping-doc write in /api/waitlist is the authoritative uniqueness check
// and bumps to 8 chars on the rare clash.
function makeReferralCode(value, len = 7) {
  const e = String(value == null ? '' : value)
    .trim()
    .toLowerCase();
  if (!e) return '';
  const hash = crypto.createHash('sha256').update(e).digest();
  let buffer = 0;
  let bits = 0;
  let out = '';
  for (let i = 0; i < hash.length && out.length < len; i++) {
    buffer = (buffer << 8) | hash[i];
    bits += 8;
    while (bits >= 5 && out.length < len) {
      bits -= 5;
      out += CROCKFORD[(buffer >> bits) & 31];
    }
    buffer &= (1 << bits) - 1; // drop already-emitted high bits (keeps buffer < 2^13)
  }
  return out;
}

// Normalize a user-typed code: uppercase, fold the look-alikes people actually
// confuse (O→0, I/L→1), strip anything outside the Crockford alphabet, and
// require a plausible length. Returns '' for junk. A typo that drops/garbles a
// char just won't resolve to a referrer (no credit), never an error.
function sanitizeReferralCode(v) {
  const s = String(v == null ? '' : v)
    .trim()
    .toUpperCase()
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1')
    .split('')
    .filter((c) => CROCKFORD_SET.has(c))
    .join('');
  if (s.length < 4 || s.length > 12) return '';
  return s;
}

// --- Waitlist priority score ----------------------------------------------
// The single field the waitlist is organized by (orderBy desc). Higher = closer
// to the top. Survey-completers occupy a dominant tier (+1e9) so they always
// rank above non-completers; within a tier, earlier signups (smaller seq) rank
// higher. Every referral you GIVE adds +10 (jumps you ~10 spots up); USING a
// friend's code once adds +5 (jumps the new joiner ~5 spots up).
const SURVEY_TIER = 1e9;
const REFERRAL_BONUS = 10; // per referral you give
const REFERRED_BONUS = 5; // one-time, for joining with someone's code
function priorityScore({
  surveyComplete = false,
  seq = 0,
  referralCount = 0,
  usedReferral = false,
} = {}) {
  return (
    (surveyComplete ? SURVEY_TIER : 0) -
    (Number(seq) || 0) +
    REFERRAL_BONUS * (Number(referralCount) || 0) +
    (usedReferral ? REFERRED_BONUS : 0)
  );
}

// --- Career stage (chip) ---------------------------------------------------
// Kept as a Set so allowlist membership is O(1). Must match the data-value
// attributes in index.html exactly, including the en-dash in "0–2" etc.
const VALID_CAREER_STAGES = new Set([
  'Student',
  'Early-career (0-3yrs)',
  'Mid-career (4-10yrs)',
  'Experienced-career (10+ yrs)',
  'Self-employed',
  'Business owner',
  'Not working',
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
  'Living with family',
  'Living alone',
  'Living with partner',
  'Living with partner + children',
  'Single parent',
  'Caregiving for family member(s)',
  'Empty nester',
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
// every deploy produces uncorrelated hashes, which is annoying but safe.
function hashIp(ip) {
  const salt = process.env.IP_HASH_SALT;
  if (!salt || !ip) return null;
  return crypto
    .createHash('sha256')
    .update(salt + '|' + ip)
    .digest('hex')
    .slice(0, 16);
}

// --- Phone-keyed doc id ----------------------------------------------------
// Deterministic Firestore doc id derived from the canonical (E.164) phone, so
// every write for one person upserts ONE doc, this dedupes both waitlist
// signups and survey responses (incl. abandoners who reopen/reload) instead of
// creating a new doc each time. Used as the doc id in BOTH the `waitlist` and
// `survey` collections (same id, different collections).
//
// We hash (rather than use the raw number as the id) to keep PII out of the
// document PATH, ids surface in logs, exports, and backups. The number itself
// is still stored in the `phone` FIELD for joins/lookups. We canonicalize via
// sanitizePhone first so "+1 (416) 555-0123" and "+14165550123" map to one id.
//
// Unsalted on purpose: it must be stable across deploys AND recomputable for a
// known number (so you can look a record up). It is not a secret, client
// access to Firestore is deny-all, the Admin SDK bypasses rules.
function phoneDocId(phone) {
  const p = sanitizePhone(phone);
  if (!p) return null;
  return 'p_' + crypto.createHash('sha256').update(p).digest('hex');
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

  // Reject anything over 16 KB, the largest legitimate survey is ~3 KB.
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
// no other Firebase Web SDK use, pulling in the Firebase JS bundle just to
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
    // If Google is unreachable, fail OPEN, better to accept a real signup
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
// catches the most common abuse pattern, same attacker, rapid bursts).
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
      // First hit in a fresh window, apply TTL.
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
  sanitizePhone,
  isPlausiblePhone,
  sanitizeRegion,
  sanitizeSource,
  sanitizeChannel,
  sanitizeVariant,
  sanitizeReferralCode,
  makeReferralCode,
  priorityScore,
  SURVEY_TIER,
  REFERRAL_BONUS,
  REFERRED_BONUS,
  sanitizeCareerStage,
  sanitizeLifeStage,
  sanitizeScale,
  scaleToNumber,
  sanitizeYesNo,
  sanitizeText,
  sanitizeInt,
  hashIp,
  phoneDocId,
  clientIp,
  readBody,
  verifyRecaptcha,
  rateLimit,
};
