/**
 * POST /api/lookup
 *
 * Self-service referral-code lookup for someone already on the waitlist: they
 * enter their phone number and get their shareable code + current position
 * back. Used by the "Find your invite code" popup on /referral.
 *
 * Referral codes are not secret (they're meant to be shared) and position isn't
 * sensitive, so this is low-risk; it is rate-limited per IP to throttle the
 * (minor) number-enumeration surface. Read-only, no reCAPTCHA.
 *
 * Body (JSON or form-urlencoded):
 *   phone  required
 *
 * Response:
 *   200 { ok: true, found: true,  referralCode, position }
 *   200 { ok: true, found: false }                        // not on the waitlist yet
 *   400 { ok: false, reason: 'phone' }
 *   429 { ok: false, reason: 'rate-limited' }
 *   500 { ok: false, reason: 'server' }
 */
const { db } = require('./_lib/firestore');
const {
  readBody,
  clientIp,
  hashIp,
  phoneDocId,
  sanitizePhone,
  isPlausiblePhone,
  makeReferralCode,
  rateLimit,
} = require('./_lib/validate');
const { computePosition } = require('./_lib/ranking');

module.exports = async function handler(req, res) {
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

  const phone = sanitizePhone(body.phone);
  if (!isPlausiblePhone(phone)) return res.status(400).json({ ok: false, reason: 'phone' });

  const ip = clientIp(req);
  const rl = await rateLimit('rl:lookup:' + (hashIp(ip) || ip || 'unknown'), {
    max: 10,
    windowSec: 60,
  });
  if (!rl.allowed) {
    res.setHeader('Retry-After', '60');
    return res.status(429).json({ ok: false, reason: 'rate-limited' });
  }

  try {
    const database = db();
    const docId = phoneDocId(phone);
    const snap = await database.collection('waitlist').doc(docId).get();
    if (!snap.exists) return res.status(200).json({ ok: true, found: false });

    const data = snap.data() || {};
    const referralCode = data.referralCode || makeReferralCode(phone);
    const position = await computePosition(
      database,
      typeof data.priorityScore === 'number' ? data.priorityScore : null,
    );
    return res.status(200).json({ ok: true, found: true, referralCode, position });
  } catch (err) {
    console.error('[lookup] failed:', err);
    return res.status(500).json({ ok: false, reason: 'server' });
  }
};
