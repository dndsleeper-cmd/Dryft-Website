/**
 * POST /api/waitlist
 *
 * Captures a waitlist signup. UPSERTS one document per email (doc id derived
 * from the email via emailDocId), so re-signing up with the same email updates
 * the existing record instead of creating a duplicate.
 *
 * Body (JSON or form-urlencoded):
 *   email     required — sanitized + validated server-side
 *   source    required — "hero" or "final"
 *   dwell_ms  optional — ms the user spent on the page before submit
 *
 * Response:
 *   200 { ok: true, id }
 *   400 { ok: false, reason }
 *   413 { ok: false, reason: 'payload too large' }
 *   500 { ok: false, reason: 'server' }
 */
const { db, serverTimestamp } = require('./_lib/firestore');
const {
  readBody,
  clientIp,
  hashIp,
  emailDocId,
  sanitizeEmail,
  isPlausibleEmail,
  sanitizeSource,
  sanitizeInt,
  verifyRecaptcha,
  rateLimit,
} = require('./_lib/validate');

module.exports = async function handler(req, res) {
  // Same-origin only (the site posts from thedryft.com). Block other methods
  // and reject preflight from unexpected origins by simply not setting CORS.
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ ok: false, reason: 'method' });
  }

  let body;
  try {
    body = await readBody(req);
  } catch (err) {
    const tooBig = String((err && err.message) || '').includes('too large');
    return res.status(tooBig ? 413 : 400).json({
      ok: false,
      reason: tooBig ? 'payload too large' : 'bad body',
    });
  }

  const email = sanitizeEmail(body.email);
  const source = sanitizeSource(body.source);
  const dwell = sanitizeInt(body.dwell_ms);

  if (!isPlausibleEmail(email)) return res.status(400).json({ ok: false, reason: 'email' });
  if (!source) return res.status(400).json({ ok: false, reason: 'source' });

  const ip = clientIp(req);
  const ua = String(req.headers['user-agent'] || '').slice(0, 300);
  const ipHashVal = hashIp(ip);

  // App Check: reCAPTCHA v3 token verification. No-op if RECAPTCHA_SECRET_KEY
  // isn't set, so the endpoint stays functional in dev / before provisioning.
  const verif = await verifyRecaptcha(body.recaptchaToken, ip);
  if (!verif.ok) {
    return res.status(403).json({ ok: false, reason: 'recaptcha:' + verif.reason });
  }

  // Rate limit: 5 waitlist submits per IP per 60 seconds. Falls back to
  // in-memory when Upstash isn't configured.
  const rlKey = 'rl:waitlist:' + (ipHashVal || ip || 'unknown');
  const rl = await rateLimit(rlKey, { max: 5, windowSec: 60 });
  if (!rl.allowed) {
    res.setHeader('Retry-After', String(Math.ceil((rl.retryAfterMs || 60000) / 1000)));
    return res.status(429).json({ ok: false, reason: 'rate-limited' });
  }

  try {
    // Upsert one doc per email so re-signups don't create duplicates.
    // createdAt + first source are stamped once; the rest refreshes each time.
    const docId = emailDocId(email);
    const ref = db().collection('waitlist').doc(docId);
    const snap = await ref.get();
    const payload = {
      email,
      emailLower: email.toLowerCase(),
      source,
      dwellMs: dwell,
      ipHash: ipHashVal,
      userAgent: ua,
      updatedAt: serverTimestamp(),
    };
    if (!snap.exists) {
      payload.createdAt = serverTimestamp();
      payload.signupCount = 1;
    } else {
      // Track re-signups without losing the original timestamp/source.
      const prev = snap.data() || {};
      payload.signupCount = (typeof prev.signupCount === 'number' ? prev.signupCount : 1) + 1;
    }
    await ref.set(payload, { merge: true });
    return res.status(200).json({ ok: true, id: docId });
  } catch (err) {
    console.error('[waitlist] write failed:', err);
    return res.status(500).json({ ok: false, reason: 'server' });
  }
};
