/**
 * GET /api/stats
 *
 * Public, read-only social-proof number: how many people are on the waitlist.
 * Powers the "Join N others on the waitlist" line on the landing page.
 *
 * Response:
 *   200 { ok: true, count }
 *   429 { ok: false, reason: 'rate-limited' }
 *   500 { ok: false, reason: 'server' }
 */
const { db } = require('./_lib/firestore');
const { clientIp, hashIp, rateLimit } = require('./_lib/validate');
const { totalCount } = require('./_lib/ranking');

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ ok: false, reason: 'method' });
  }

  const ip = clientIp(req);
  const rl = await rateLimit('rl:stats:' + (hashIp(ip) || ip || 'unknown'), {
    max: 60,
    windowSec: 60,
  });
  if (!rl.allowed) {
    res.setHeader('Retry-After', '60');
    return res.status(429).json({ ok: false, reason: 'rate-limited' });
  }

  try {
    const count = await totalCount(db());
    // Brief CDN/browser cache — this number changes slowly and is purely cosmetic.
    res.setHeader('Cache-Control', 'public, max-age=60');
    return res.status(200).json({ ok: true, count });
  } catch (err) {
    console.error('[stats] failed:', err);
    return res.status(500).json({ ok: false, reason: 'server' });
  }
};
