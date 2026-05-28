/**
 * POST /api/survey
 *
 * Captures a survey response, keyed by email so we collect data even from users
 * who never reach the final "Send answers" button. Every write UPSERTS a single
 * Firestore doc whose id is derived from the email (surveyDocId), so:
 *   - changing an answer overwrites the previous value (set + merge), and
 *   - the same person reopening/reloading the survey reuses ONE doc
 *     (abandoners are deduped, not duplicated).
 *
 * Two modes:
 *   1. PARTIAL autosave — `partial: true`. Fired on every selection change.
 *      Relaxed validation (the user may have answered almost nothing yet),
 *      reCAPTCHA skipped, looser rate-limit bucket. Stored complete:false.
 *   2. COMPLETE submit — the final "Send answers" (`complete: true`, no
 *      `partial`). Strict required-field contract + reCAPTCHA. Stored
 *      complete:true on the SAME (email-keyed) doc.
 *
 * Body (JSON or form-urlencoded):
 *   email        required — the doc key (and joins a response to its signup)
 *   partial      optional boolean — true marks an in-progress autosave
 *   complete     optional boolean — true marks the response finished
 *   source       "hero" | "final" (required for non-partial writes)
 *   careerStage  one of VALID_CAREER_STAGES (required for non-partial)
 *   lifeStage    one of VALID_LIFE_STAGES (required for non-partial)
 *   q1..q10      Likert scale, "1".."5" (strings on the wire, stored as ints)
 *   q11          Yes/No
 *   q12          open-ended text (optional)
 *
 * Likert questions are stored as integers (1..5) so they're aggregatable
 * in BigQuery/Looker without parseInt every time. Missing answers store as
 * null. Filter complete==false to find abandoners (you still get whatever
 * they answered before leaving).
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
  sanitizeCareerStage,
  sanitizeLifeStage,
  scaleToNumber,
  sanitizeYesNo,
  sanitizeText,
  verifyRecaptcha,
  rateLimit,
} = require('./_lib/validate');

// Likert question field names — keep this in sync with the form. Field names
// now match the on-screen display order (q1..q10 = the ten 1–5 questions, in the
// order shown). The order here defines storage shape; rearranging is a NO-OP for
// stored data because each field is keyed by name.
const LIKERT_KEYS = ['q1', 'q2', 'q3', 'q4', 'q5', 'q6', 'q7', 'q8', 'q9', 'q10'];

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

  const email = sanitizeEmail(body.email);
  const source = sanitizeSource(body.source);
  const careerStage = sanitizeCareerStage(body.careerStage);
  const lifeStage = sanitizeLifeStage(body.lifeStage);

  // A write is a "partial" autosave when explicitly flagged. Partial writes
  // upsert progressively, so we relax the required-field contract (the user
  // may have answered almost nothing yet).
  const isPartial = body.partial === true || body.partial === 'true';
  const isComplete = body.complete === true || body.complete === 'true';

  // Email is ALWAYS required — it's both the doc key and the join to a signup.
  if (!isPlausibleEmail(email)) return res.status(400).json({ ok: false, reason: 'email' });

  // Non-partial (complete / legacy) submissions keep the strict contract.
  if (!isPartial) {
    if (!source) return res.status(400).json({ ok: false, reason: 'source' });
    if (!careerStage) return res.status(400).json({ ok: false, reason: 'careerStage' });
    if (!lifeStage) return res.status(400).json({ ok: false, reason: 'lifeStage' });
  }

  const ip = clientIp(req);
  const ua = String(req.headers['user-agent'] || '').slice(0, 300);
  const ipHashVal = hashIp(ip);

  // reCAPTCHA: enforce on complete/legacy submits only. Partial autosaves fire
  // many times per session and v3 tokens expire (~2 min), so minting one per
  // keystroke is impractical — we lean on the dedicated rate-limit bucket below.
  if (!isPartial) {
    const verif = await verifyRecaptcha(body.recaptchaToken, ip);
    if (!verif.ok) {
      return res.status(403).json({ ok: false, reason: 'recaptcha:' + verif.reason });
    }
  }

  // Rate limit (BEFORE data-shaping so a flooder can't make us sanitize every
  // rejected request). Partial autosaves get their own, looser bucket: a user
  // answering ~13 questions (plus corrections) legitimately fires many writes.
  const rlBase = ipHashVal || ip || 'unknown';
  const rl = isPartial
    ? await rateLimit('rl:survey:auto:' + rlBase, { max: 60, windowSec: 60 })
    : await rateLimit('rl:survey:' + rlBase, { max: 3, windowSec: 60 });
  if (!rl.allowed) {
    res.setHeader('Retry-After', String(Math.ceil((rl.retryAfterMs || 60000) / 1000)));
    return res.status(429).json({ ok: false, reason: 'rate-limited' });
  }

  // Always-written metadata.
  const fields = {
    email,
    emailLower: email.toLowerCase(),
    ipHash: ipHashVal,
    userAgent: ua,
  };
  if (source) fields.source = source;

  // Answer fields are written ONLY when they carry a valid value. A blank /
  // unanswered field is omitted, so with merge:true it never overwrites a
  // previously saved answer. This is what lets a returning user's new answers
  // ACCUMULATE into their existing record instead of wiping the rest of it
  // (e.g. reopening the survey on a fresh, empty form and answering one more
  // question must not null out the other ten).
  for (const k of LIKERT_KEYS) {
    const n = scaleToNumber(body[k]); // 1..5, or null when missing/invalid
    if (n !== null) fields[k] = n;
  }
  if (careerStage) fields.careerStage = careerStage;
  if (lifeStage) fields.lifeStage = lifeStage;
  const q11 = sanitizeYesNo(body.q11);
  if (q11) fields.q11 = q11; // 'Yes' | 'No'
  const q12 = sanitizeText(body.q12);
  if (q12) fields.q12 = q12; // free text, max 2000 chars

  try {
    // Upsert ONE doc per email. set+merge means a changed selection overwrites
    // just that field, and a returning/reloading user reuses the same doc
    // (no duplicates). createdAt is stamped only on first write.
    const docId = emailDocId(email);
    const ref = db().collection('survey').doc(docId);
    const snap = await ref.get();
    // Completion is sticky: once a response is marked complete, a later partial
    // autosave can't downgrade it back to incomplete.
    const wasComplete = snap.exists && !!(snap.data() && snap.data().complete === true);
    const complete = isComplete || wasComplete;
    const payload = { ...fields, complete, updatedAt: serverTimestamp() };
    if (!snap.exists) payload.createdAt = serverTimestamp();
    await ref.set(payload, { merge: true });
    return res.status(200).json({ ok: true, id: docId, complete });
  } catch (err) {
    console.error('[survey] write failed:', err);
    return res.status(500).json({ ok: false, reason: 'server' });
  }
};
