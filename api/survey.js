/**
 * POST /api/survey
 *
 * Captures a survey response, keyed by phone so we collect data even from users
 * who never reach the final "Send answers" button. Every write UPSERTS a single
 * Firestore doc whose id is derived from the phone (phoneDocId), so:
 *   - changing an answer overwrites the previous value (set + merge), and
 *   - the same person reopening/reloading the survey reuses ONE doc
 *     (abandoners are deduped, not duplicated).
 *
 * Two modes:
 *   1. PARTIAL autosave, `partial: true`. Fired on every selection change.
 *      Relaxed validation (the user may have answered almost nothing yet),
 *      reCAPTCHA skipped, looser rate-limit bucket. Stored complete:false.
 *   2. COMPLETE submit, the final "Send answers" (`complete: true`, no
 *      `partial`). Strict required-field contract + reCAPTCHA. Stored
 *      complete:true on the SAME (phone-keyed) doc.
 *
 * Body (JSON or form-urlencoded):
 *   phone        required, the doc key (and joins a response to its signup)
 *   partial      optional boolean, true marks an in-progress autosave
 *   complete     optional boolean, true marks the response finished
 *   source       "hero" | "final" (required for non-partial writes)
 *   careerStage  one of VALID_CAREER_STAGES (required for non-partial)
 *   lifeStage    one of VALID_LIFE_STAGES (required for non-partial)
 *   q1..q7       Likert scale, "1".."5" (strings on the wire, stored as ints)
 *   q8           Yes/No
 *   q9           open-ended text (optional)
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
  phoneDocId,
  sanitizePhone,
  isPlausiblePhone,
  sanitizeSource,
  sanitizeCareerStage,
  sanitizeLifeStage,
  scaleToNumber,
  sanitizeYesNo,
  sanitizeText,
  makeReferralCode,
  priorityScore,
  verifyRecaptcha,
  rateLimit,
} = require('./_lib/validate');
const { computePosition } = require('./_lib/ranking');

// Likert question field names, keep this in sync with the form. Field names
// match the on-screen display order (q1..q7 = the seven 1–5 questions, in the
// order shown; q8 = Yes/No, q9 = open text). The order here defines storage
// shape; rearranging is a NO-OP for stored data because each field is keyed by name.
const LIKERT_KEYS = ['q1', 'q2', 'q3', 'q4', 'q5', 'q6', 'q7'];

// When a survey is marked complete, lift the matching waitlist doc into the
// "survey-completed" tier so it ranks above non-completers. Same phone-derived
// doc id joins the two collections. Recomputes priorityScore from the doc's
// current seq/referralCount (idempotent, re-running yields the same score).
// Defensive: if the waitlist doc is somehow missing (signup POST failed but the
// survey landed), create a minimal one. Returns the resulting position, or null.
async function syncWaitlistOnComplete(database, docId, phone) {
  const userRef = database.collection('waitlist').doc(docId);
  const counterRef = database.collection('meta').doc('counters');
  const score = await database.runTransaction(async (tx) => {
    const snap = await tx.get(userRef);
    if (snap.exists) {
      const prev = snap.data() || {};
      const referralCount = Number(prev.referralCount) || 0;
      const usedReferral = !!prev.usedReferral;
      // Already in the completed tier with a real score, nothing to change.
      if (prev.surveyComplete === true && typeof prev.priorityScore === 'number') {
        return prev.priorityScore;
      }
      let seq = typeof prev.seq === 'number' ? prev.seq : null;
      if (seq === null) {
        const cs = await tx.get(counterRef);
        seq = (Number(cs.exists && cs.data().waitlistSeq) || 0) + 1;
        tx.set(counterRef, { waitlistSeq: seq }, { merge: true });
      }
      const sc = priorityScore({ surveyComplete: true, seq, referralCount, usedReferral });
      tx.set(
        userRef,
        {
          surveyComplete: true,
          seq,
          referralCount,
          priorityScore: sc,
          updatedAt: serverTimestamp(),
        },
        { merge: true },
      );
      return sc;
    }
    // No waitlist doc, create a minimal completed one so the response still ranks.
    const cs = await tx.get(counterRef);
    const seq = (Number(cs.exists && cs.data().waitlistSeq) || 0) + 1;
    const code = makeReferralCode(phone);
    const sc = priorityScore({ surveyComplete: true, seq, referralCount: 0 });
    tx.set(counterRef, { waitlistSeq: seq }, { merge: true });
    tx.set(
      userRef,
      {
        phone,
        source: 'survey',
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
        signupCount: 1,
        seq,
        referralCode: code,
        referralCount: 0,
        surveyComplete: true,
        priorityScore: sc,
      },
      { merge: true },
    );
    tx.set(
      database.collection('referralCodes').doc(code),
      { ownerId: docId, phone },
      { merge: true },
    );
    return sc;
  });
  return computePosition(database, score);
}

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
  const source = sanitizeSource(body.source);
  const careerStage = sanitizeCareerStage(body.careerStage);
  const lifeStage = sanitizeLifeStage(body.lifeStage);

  // A write is a "partial" autosave when explicitly flagged. Partial writes
  // upsert progressively, so we relax the required-field contract (the user
  // may have answered almost nothing yet).
  const isPartial = body.partial === true || body.partial === 'true';
  const isComplete = body.complete === true || body.complete === 'true';

  // Phone is ALWAYS required, it's both the doc key and the join to a signup.
  if (!isPlausiblePhone(phone)) return res.status(400).json({ ok: false, reason: 'phone' });

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
  // keystroke is impractical, we lean on the dedicated rate-limit bucket below.
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
    phone,
    ipHash: ipHashVal,
    userAgent: ua,
  };
  if (source) fields.source = source;

  // Answer fields are written ONLY when they carry a valid value. A blank /
  // unanswered field is omitted, so with merge:true it never overwrites a
  // previously saved answer. This is what lets a returning user's new answers
  // ACCUMULATE into their existing record instead of wiping the rest of it
  // (e.g. reopening the survey on a fresh, empty form and answering one more
  // question must not null out the others).
  for (const k of LIKERT_KEYS) {
    const n = scaleToNumber(body[k]); // 1..5, or null when missing/invalid
    if (n !== null) fields[k] = n;
  }
  if (careerStage) fields.careerStage = careerStage;
  if (lifeStage) fields.lifeStage = lifeStage;
  const q8 = sanitizeYesNo(body.q8);
  if (q8) fields.q8 = q8; // 'Yes' | 'No'
  const q9 = sanitizeText(body.q9);
  if (q9) fields.q9 = q9; // free text, max 2000 chars

  try {
    // Upsert ONE doc per phone. set+merge means a changed selection overwrites
    // just that field and a returning/reloading user reuses the same doc.
    //
    // NO read on the hot path: the frequent per-answer autosave is now a PURE
    // write (no get()), which halves Firestore ops on the survey path.
    //   - Stickiness: `complete` is written ONLY on the final submit and OMITTED
    //     on partials, so a merge can never downgrade a finished response,
    //     no read needed to "remember" it.
    //   - We don't stamp a survey-doc createdAt; the waitlist doc (written at
    //     signup, before the survey) already holds the authoritative per-user
    //     timestamp, so it was duplicative. `updatedAt` still tracks recency.
    const docId = phoneDocId(phone);
    const ref = db().collection('survey').doc(docId);
    const payload = { ...fields, updatedAt: serverTimestamp() };
    if (isComplete) payload.complete = true; // final "Send answers" submit only
    await ref.set(payload, { merge: true });

    // Only the explicit final submit promotes the waitlist doc into the
    // survey-completed tier ("skip the line") and reports a position, partial
    // autosaves never reach here. syncWaitlistOnComplete is idempotent, so a
    // repeated submit is a safe no-op. Best-effort: a failure must not fail the
    // survey write the user just made.
    let position = null;
    if (isComplete) {
      try {
        position = await syncWaitlistOnComplete(db(), docId, phone);
      } catch (err) {
        console.warn('[survey] waitlist sync failed:', err && err.message);
      }
    }
    return res.status(200).json({ ok: true, id: docId, complete: isComplete, position });
  } catch (err) {
    console.error('[survey] write failed:', err);
    return res.status(500).json({ ok: false, reason: 'server' });
  }
};
