/**
 * POST /api/waitlist
 *
 * Captures a waitlist signup. UPSERTS one document per phone number (doc id
 * derived from the E.164 phone via phoneDocId), so re-signing up with the same
 * number updates the existing record instead of creating a duplicate.
 *
 * Body (JSON or form-urlencoded):
 *   phone     required, mobile number for SMS; sanitized + validated server-side
 *   region    optional, "CA" | "US" (dial-code dropdown selection)
 *   source    required, "hero" or "final"
 *   dwell_ms  optional, ms the user spent on the page before submit
 *
 * Response:
 *   200 { ok: true, id }
 *   400 { ok: false, reason }
 *   413 { ok: false, reason: 'payload too large' }
 *   500 { ok: false, reason: 'server' }
 */
const { db, serverTimestamp, increment } = require('./_lib/firestore');
const {
  readBody,
  clientIp,
  hashIp,
  phoneDocId,
  sanitizePhone,
  isPlausiblePhone,
  sanitizeRegion,
  sanitizeSource,
  sanitizeChannel,
  sanitizeVariant,
  sanitizeReferralCode,
  makeReferralCode,
  priorityScore,
  REFERRAL_BONUS,
  sanitizeInt,
  verifyRecaptcha,
  rateLimit,
} = require('./_lib/validate');
const { computePosition } = require('./_lib/ranking');

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

  const phone = sanitizePhone(body.phone);
  const region = sanitizeRegion(body.region);
  const source = sanitizeSource(body.source);
  const channel = sanitizeChannel(body.channel);
  const variant = sanitizeVariant(body.variant);
  const dwell = sanitizeInt(body.dwell_ms);

  if (!isPlausiblePhone(phone)) return res.status(400).json({ ok: false, reason: 'phone' });
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

  const docId = phoneDocId(phone);
  const myCode = makeReferralCode(phone);
  const referredByCode = sanitizeReferralCode(body.referredByCode);

  try {
    const database = db();
    const userRef = database.collection('waitlist').doc(docId);
    const counterRef = database.collection('meta').doc('counters');

    // One transaction so the seq counter, the user doc, the code→owner mapping,
    // and the referrer credit all commit together. Firestore requires ALL reads
    // before ALL writes, so every tx.get() below precedes the tx.set() calls.
    const result = await database.runTransaction(async (tx) => {
      const userSnap = await tx.get(userRef);
      const isNew = !userSnap.exists;
      const prev = userSnap.exists ? userSnap.data() || {} : {};

      // Resolve a referrer only for a brand-new signup that supplied a code and
      // hasn't already been credited. Self-referral is ignored.
      let referrerRef = null;
      if (isNew && referredByCode && referredByCode !== myCode && !prev.referredByCode) {
        const mapSnap = await tx.get(database.collection('referralCodes').doc(referredByCode));
        if (mapSnap.exists) {
          const ownerId = (mapSnap.data() || {}).ownerId;
          if (ownerId && ownerId !== docId) {
            referrerRef = database.collection('waitlist').doc(ownerId);
          }
        }
      }

      // A monotonic seq is assigned on first signup (and backfilled for any
      // legacy doc that predates this feature). Read the counter up front.
      const needsSeq = isNew || typeof prev.seq !== 'number';
      const counterSnap = needsSeq ? await tx.get(counterRef) : null;

      // ---- writes (all reads are done above) ----
      const base = {
        phone,
        source,
        dwellMs: dwell,
        ipHash: ipHashVal,
        userAgent: ua,
        updatedAt: serverTimestamp(),
      };
      if (region) base.region = region;

      if (isNew) {
        const seq = (Number(counterSnap.exists && counterSnap.data().waitlistSeq) || 0) + 1;
        // Joining with a valid code bumps the new signup up 5 spots (+5).
        const usedReferral = !!referrerRef;
        const score = priorityScore({ surveyComplete: false, seq, referralCount: 0, usedReferral });
        const payload = {
          ...base,
          createdAt: serverTimestamp(),
          signupCount: 1,
          seq,
          referralCode: myCode,
          referralCount: 0,
          surveyComplete: false,
          usedReferral,
          priorityScore: score,
        };
        if (referrerRef) payload.referredByCode = referredByCode;
        // First-touch only: the hero variant + traffic channel that converted
        // this signup (lets the dashboard compute conversion per channel).
        if (variant) payload.variant = variant;
        if (channel) payload.channel = channel;
        tx.set(userRef, payload, { merge: true });
        tx.set(counterRef, { waitlistSeq: seq }, { merge: true });
        tx.set(
          database.collection('referralCodes').doc(myCode),
          { ownerId: docId, phone },
          { merge: true },
        );
        if (referrerRef) {
          // +1 referral, +10 spots, applied atomically so no read-modify-write race.
          tx.set(
            referrerRef,
            {
              referralCount: increment(1),
              priorityScore: increment(REFERRAL_BONUS),
              updatedAt: serverTimestamp(),
            },
            { merge: true },
          );
        }
        return { referralCode: myCode, score };
      }

      // Re-signup: refresh metadata, bump signupCount; never re-seq or re-credit.
      const payload = { ...base, signupCount: (Number(prev.signupCount) || 1) + 1 };
      let score = typeof prev.priorityScore === 'number' ? prev.priorityScore : null;
      if (!prev.referralCode) {
        payload.referralCode = myCode;
        tx.set(
          database.collection('referralCodes').doc(myCode),
          { ownerId: docId, phone },
          { merge: true },
        );
      }
      if (needsSeq) {
        // Legacy doc with no seq/score, assign one now so it can be ranked.
        const seq = (Number(counterSnap.exists && counterSnap.data().waitlistSeq) || 0) + 1;
        const referralCount = Number(prev.referralCount) || 0;
        const surveyComplete = !!prev.surveyComplete;
        const usedReferral = !!prev.usedReferral;
        score = priorityScore({ surveyComplete, seq, referralCount, usedReferral });
        payload.seq = seq;
        payload.referralCount = referralCount;
        payload.surveyComplete = surveyComplete;
        payload.priorityScore = score;
        tx.set(counterRef, { waitlistSeq: seq }, { merge: true });
      }
      tx.set(userRef, payload, { merge: true });
      return { referralCode: prev.referralCode || myCode, score };
    });

    // Note: we intentionally do NOT compute the total signup count here, that
    // would be a second aggregation read per signup. The client increments its
    // displayed "N joined" by +1 optimistically; /api/stats is the source of truth.
    const position = await computePosition(database, result.score);
    return res
      .status(200)
      .json({ ok: true, id: docId, referralCode: result.referralCode, position });
  } catch (err) {
    console.error('[waitlist] write failed:', err);
    return res.status(500).json({ ok: false, reason: 'server' });
  }
};
