/**
 * Shared waitlist-ranking queries used by /api/{waitlist,survey,lookup,stats}.
 *
 * Both are best-effort aggregation reads — a failure must never break the write
 * the user just made, so callers treat a null return as "unknown".
 */

// Position = the number of docs ranked strictly above you, +1. One Firestore
// aggregation query (no full scan). Requires the single-field index on
// `priorityScore`, which Firestore auto-creates.
async function computePosition(database, score) {
  if (typeof score !== 'number') return null;
  try {
    const agg = await database
      .collection('waitlist')
      .where('priorityScore', '>', score)
      .count()
      .get();
    return (agg.data().count || 0) + 1;
  } catch (err) {
    console.warn('[ranking] position count failed:', err && err.message);
    return null;
  }
}

// Total signups — the "Join N others on the waitlist" social-proof number.
async function totalCount(database) {
  try {
    const agg = await database.collection('waitlist').count().get();
    return agg.data().count || 0;
  } catch (err) {
    console.warn('[ranking] total count failed:', err && err.message);
    return null;
  }
}

module.exports = { computePosition, totalCount };
