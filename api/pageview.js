/**
 * POST /api/pageview
 *
 * First-party visitor counter. The client pings this only on a device's FIRST
 * load of each UTC day (it dedupes via the `dryft_seen` cookie), so every ping
 * we receive is one UNIQUE DEVICE for that day — no double-counting when someone
 * opens the site repeatedly. Because it's same-origin (not a known third-party
 * tracker), ad blockers don't block it, so these counts are far more complete
 * than GA4/Vercel client beacons.
 *
 * It writes COUNTS ONLY into one document per UTC day (`pageviews/{YYYY-MM-DD}`),
 * incrementing nested maps. No PII, no per-visit rows. Counts are daily-unique
 * devices:
 *   { total, byCountry{CC}, byDevice{mobile|tablet|desktop}, byChannel{...}, byVariant{A|B} }
 *
 * Country comes from Vercel's free `x-vercel-ip-country` geo header; device from
 * the User-Agent; channel + variant from the request body (client-classified,
 * server-revalidated). The dashboard reads these as daily-unique visitor counts.
 */
const { db, serverTimestamp, increment } = require('./_lib/firestore');
const {
  readBody,
  clientIp,
  hashIp,
  sanitizeChannel,
  sanitizeVariant,
  rateLimit,
} = require('./_lib/validate');

// Coarse device class from the User-Agent. Good enough for a visits breakdown.
function deviceFromUA(ua) {
  const s = String(ua || '').toLowerCase();
  if (/ipad|tablet|playbook|silk|(android(?!.*mobile))/.test(s)) return 'tablet';
  if (/mobi|iphone|ipod|android|phone|windows phone/.test(s)) return 'mobile';
  return 'desktop';
}

// Skip obvious bots/crawlers so they don't inflate the visit counts.
function isBot(ua) {
  return /bot|crawl|spider|slurp|crawler|facebookexternalhit|embedly|preview|monitor|lighthouse|headless|pingdom|uptime/i
    .test(String(ua || ''));
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).end();
  }

  const ua = String(req.headers['user-agent'] || '');
  // Bots: accept the request but don't count them.
  if (isBot(ua)) return res.status(204).end();

  // Lenient per-IP rate limit so a single client can't balloon the daily writes.
  try {
    const ip = clientIp(req);
    const rl = await rateLimit('rl:pv:' + (hashIp(ip) || ip || 'unknown'), { max: 100, windowSec: 60 });
    if (!rl.allowed) return res.status(204).end(); // silently drop
  } catch (_) { /* never block a pageview on the limiter */ }

  let body = {};
  try { body = await readBody(req); } catch (_) { body = {}; }

  const channel = sanitizeChannel(body.channel) || 'Direct';
  const variant = sanitizeVariant(body.variant); // '' if not A/B
  const ccRaw = String(req.headers['x-vercel-ip-country'] || '').trim().toUpperCase();
  const country = /^[A-Z]{2}$/.test(ccRaw) ? ccRaw : 'unknown';
  const device = deviceFromUA(ua);

  try {
    const day = new Date().toISOString().slice(0, 10); // UTC YYYY-MM-DD
    const update = {
      total: increment(1),
      byCountry: { [country]: increment(1) },
      byDevice: { [device]: increment(1) },
      byChannel: { [channel]: increment(1) },
      updatedAt: serverTimestamp(),
    };
    if (variant) update.byVariant = { [variant]: increment(1) };
    await db().collection('pageviews').doc(day).set(update, { merge: true });
  } catch (err) {
    console.warn('[pageview] write failed:', err && err.message);
    // Analytics must never surface an error to the page.
  }
  return res.status(204).end();
};
