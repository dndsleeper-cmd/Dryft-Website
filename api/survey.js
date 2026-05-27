/**
 * POST /api/survey
 *
 * Captures one survey response. Writes a single Firestore document under
 * the `survey` collection. The waitlist email is required so we can join
 * a response back to its signup.
 *
 * Body (JSON or form-urlencoded):
 *   email     required
 *   source    required ("hero" or "final" — which form the user came from)
 *   stage     required — one of the 5 life stages
 *   q1..q11   Likert scale, "1".."5" (strings on the wire, stored as ints)
 *   q7        Yes/No
 *   q12       open-ended text (optional)
 *
 * Likert questions are stored as integers (1..5) so they're aggregatable
 * in BigQuery/Looker without parseInt every time. Missing answers store as
 * null.
 */
const { db, serverTimestamp } = require('./_lib/firestore');
const {
  readBody, clientIp, hashIp,
  sanitizeEmail, isPlausibleEmail,
  sanitizeSource, sanitizeStage,
  scaleToNumber, sanitizeYesNo, sanitizeText,
} = require('./_lib/validate');

// Likert question field names — keep this in sync with the form. The order
// here defines storage shape; rearranging is a NO-OP for stored data because
// each field is keyed by name.
const LIKERT_KEYS = ['q1','q2','q3','q4','q5','q6','q8','q9','q10','q11'];

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ ok: false, reason: 'method' });
  }

  let body;
  try {
    body = await readBody(req);
  } catch (err) {
    const tooBig = String(err && err.message || '').includes('too large');
    return res.status(tooBig ? 413 : 400).json({
      ok: false,
      reason: tooBig ? 'payload too large' : 'bad body',
    });
  }

  const email  = sanitizeEmail(body.email);
  const source = sanitizeSource(body.source);
  const stage  = sanitizeStage(body.stage);

  if (!isPlausibleEmail(email)) return res.status(400).json({ ok: false, reason: 'email' });
  if (!source)                  return res.status(400).json({ ok: false, reason: 'source' });
  if (!stage)                   return res.status(400).json({ ok: false, reason: 'stage' });

  // Build the Likert block as integers. Missing or invalid → null so the
  // doc shape is stable across responses.
  const likert = {};
  for (const k of LIKERT_KEYS) likert[k] = scaleToNumber(body[k]);

  const q7  = sanitizeYesNo(body.q7);
  const q12 = sanitizeText(body.q12);

  const ip = clientIp(req);
  const ua = String(req.headers['user-agent'] || '').slice(0, 300);

  try {
    const docRef = await db().collection('survey').add({
      createdAt: serverTimestamp(),
      email,
      emailLower: email.toLowerCase(),
      source,
      stage,
      ...likert,
      q7,            // 'Yes' | 'No' | ''
      q12,           // free text, max 2000 chars
      ipHash: hashIp(ip),
      userAgent: ua,
    });
    return res.status(200).json({ ok: true, id: docRef.id });
  } catch (err) {
    console.error('[survey] write failed:', err);
    return res.status(500).json({ ok: false, reason: 'server' });
  }
};
