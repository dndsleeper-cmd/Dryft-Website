/**
 * GET /api/metrics
 *
 * Admin-only feed for the /dashboard. 100% owned/first-party data, no GA4:
 *   - Signups & survey/referral signal: aggregated from the `waitlist` collection.
 *   - Visitors, country, device, traffic channel, A/B visits: from the first-party
 *     `pageviews` daily counters (written by /api/pageview, which ad blockers
 *     don't block — so these counts are complete, unlike GA4/Vercel beacons).
 *     These are DAILY-UNIQUE devices: the client only pings on a device's first
 *     load of each UTC day, so `visits` here means unique visitors, not raw loads.
 * Returns COUNTS ONLY; no phone numbers or PII leave Firestore.
 *
 * Auth: Authorization: Bearer <DASHBOARD_TOKEN> (env var; 503 if unset).
 */
const crypto = require('crypto');
const { db, admin } = require('./_lib/firestore');
const { clientIp, hashIp, rateLimit } = require('./_lib/validate');

// Constant-time compare so the token can't be guessed byte-by-byte via timing.
function safeEqual(a, b) {
  const ab = Buffer.from(String(a || ''));
  const bb = Buffer.from(String(b || ''));
  if (ab.length !== bb.length) return false;
  try {
    return crypto.timingSafeEqual(ab, bb);
  } catch (_) {
    return false;
  }
}

// Add the numeric values of map `src` into `target` (both {key:count}).
function mergeCounts(target, src) {
  if (!src || typeof src !== 'object') return;
  Object.keys(src).forEach((k) => { target[k] = (target[k] || 0) + (Number(src[k]) || 0); });
}

// Product launch. EVERY dashboard metric counts from this instant — nothing
// before it shows. Signups carry precise timestamps so they're cut at the exact
// moment; visits are stored as one counter per UTC day (no per-visit times), so
// they start from the launch DAY — and that day's counter also includes any
// pre-launch visits from earlier that day, since a day can't be sub-split.
// Override per deploy with LAUNCH_AT (ISO 8601). Nothing is deleted, pre-launch
// data is just excluded, so it's fully reversible by moving this date.
const LAUNCH_AT_DEFAULT = '2026-06-08T17:00:00Z'; // Jun 8, 2026 · 1:00pm ET (EDT, UTC-4)

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ ok: false, reason: 'method' });
  }

  const token = process.env.DASHBOARD_TOKEN || '';
  if (!token) return res.status(503).json({ ok: false, reason: 'not-configured' });

  const ip = clientIp(req);
  const ipKey = hashIp(ip) || ip || 'unknown';

  const auth = String(req.headers.authorization || '');
  const bearer = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!safeEqual(bearer, token)) {
    // Brute-force lockout. Count ONLY wrong-token attempts (this gate runs
    // before the general limiter below, which never saw failed auth). After
    // MAX_AUTH_FAILS misses from one IP inside the window, further guesses get
    // a 429 instead of a 401, so the token can't be hammered. Because only
    // failures are counted, a legit admin with the correct token is never
    // blocked, and an attacker can't lock the real admin out either.
    const MAX_AUTH_FAILS = 8;
    const lock = await rateLimit('rl:metrics:auth:' + ipKey, {
      max: MAX_AUTH_FAILS,
      windowSec: 900, // 15-minute lockout window
    });
    if (!lock.allowed) {
      res.setHeader('Retry-After', String(Math.ceil((lock.retryAfterMs || 900000) / 1000)));
      return res.status(429).json({ ok: false, reason: 'locked-out' });
    }
    return res.status(401).json({ ok: false, reason: 'unauthorized' });
  }

  // General per-IP throttle on authenticated traffic (bounds the Firestore
  // reads a single dashboard / token holder can drive).
  const rl = await rateLimit('rl:metrics:' + ipKey, { max: 30, windowSec: 60 });
  if (!rl.allowed) {
    res.setHeader('Retry-After', '60');
    return res.status(429).json({ ok: false, reason: 'rate-limited' });
  }

  // Timeline window (days). Dropdown-driven; defaults to 30 if missing/invalid.
  const ALLOWED_DAYS = [7, 14, 30, 90, 365];
  const reqDays = parseInt((req.query && req.query.days) || '', 10);
  const days = ALLOWED_DAYS.indexOf(reqDays) !== -1 ? reqDays : 30;
  const now = Date.now();
  const cutoff = now - days * 86400000;
  const dayStr = (ms) => new Date(ms).toISOString().slice(0, 10);

  // Launch epoch (see LAUNCH_AT_DEFAULT note). Read per-request so it can be
  // overridden. The effective start is the LATER of the selected window and
  // launch, so nothing before launch ever shows, whatever range is picked.
  const launchAt = process.env.LAUNCH_AT || LAUNCH_AT_DEFAULT;
  const launchMs = Date.parse(launchAt);
  const launchDay = dayStr(launchMs); // UTC day, for the day-granular visit counters
  const startMs = Math.max(cutoff, launchMs);

  try {
    const database = db();
    const CAP = 5000; // pre-launch volumes are tiny; cap keeps the read bounded.
    const snap = await database
      .collection('waitlist')
      .select(
        'source', 'region', 'variant', 'channel', 'surveyComplete',
        'usedReferral', 'referralCount', 'referralCode', 'createdAt',
      )
      .limit(CAP)
      .get();

    const byRegion = {};
    const byVariant = {};
    const variantSurvey = {}; // variant -> # who also completed the survey
    const byChannelSignups = {}; // first-touch channel -> signups
    const byDay = {};
    const referrers = [];
    let total = 0;
    let surveyComplete = 0;
    let usedReferral = 0;
    let referralsGiven = 0;

    snap.forEach((doc) => {
      const d = doc.data() || {};

      // Scope owned metrics to [launch, now] intersected with the selected
      // window (startMs = the later of the two). Docs with no parseable createdAt
      // can't be time-bucketed, so they're excluded.
      const ts = d.createdAt;
      const t = ts && typeof ts.toDate === 'function' ? ts.toDate().getTime() : null;
      if (t === null || t < startMs) return;
      total++;

      const reg = d.region || 'unknown';
      byRegion[reg] = (byRegion[reg] || 0) + 1;

      if (d.channel) byChannelSignups[d.channel] = (byChannelSignups[d.channel] || 0) + 1;

      // Only A/B variants count toward the test (the loop already excludes
      // pre-launch signups, so these are post-launch by construction).
      const v = d.variant === 'A' || d.variant === 'B' ? d.variant : null;
      if (v) byVariant[v] = (byVariant[v] || 0) + 1;

      if (d.surveyComplete) {
        surveyComplete++;
        if (v) variantSurvey[v] = (variantSurvey[v] || 0) + 1;
      }
      if (d.usedReferral) usedReferral++;

      const rc = Number(d.referralCount) || 0;
      referralsGiven += rc;
      if (rc > 0 && d.referralCode) referrers.push({ code: d.referralCode, count: rc });

      byDay[dayStr(t)] = (byDay[dayStr(t)] || 0) + 1;
    });

    referrers.sort((a, b) => b.count - a.count);

    // First-party pageview counters for the window (one doc per UTC day).
    const pv = { total: 0, byDay: {}, byCountry: {}, byDevice: {}, byChannel: {}, byVariant: {} };
    try {
      const firstDay = dayStr(now - (days - 1) * 86400000);
      const lastDay = dayStr(now);
      const pvSnap = await database
        .collection('pageviews')
        .orderBy(admin.firestore.FieldPath.documentId())
        .startAt(firstDay)
        .endAt(lastDay)
        .get();
      pvSnap.forEach((doc) => {
        // Day-granular launch filter: a day's counter can't be sub-split, so the
        // launch day is included whole (may hold a few pre-launch visits).
        if (doc.id < launchDay) return;
        const x = doc.data() || {};
        pv.total += Number(x.total) || 0;
        pv.byDay[doc.id] = Number(x.total) || 0;
        mergeCounts(pv.byCountry, x.byCountry);
        mergeCounts(pv.byDevice, x.byDevice);
        mergeCounts(pv.byChannel, x.byChannel);
        mergeCounts(pv.byVariant, x.byVariant);
      });
    } catch (e) {
      console.warn('[metrics] pageviews read failed:', e && e.message);
    }

    // Conversion per traffic channel: owned signups ÷ first-party visits.
    const channelKeys = Object.keys(pv.byChannel);
    Object.keys(byChannelSignups).forEach((k) => {
      if (channelKeys.indexOf(k) === -1) channelKeys.push(k);
    });
    const byChannel = channelKeys
      .map((k) => {
        const visits = pv.byChannel[k] || 0;
        const signups = byChannelSignups[k] || 0;
        return { channel: k, visits: visits, signups: signups, rate: visits ? +(signups / visits).toFixed(4) : 0 };
      })
      .sort((a, b) => b.visits - a.visits);

    // Dense daily series from launch (or the window start, whichever is later)
    // to today, zero-filled. Days before launch are dropped so the chart doesn't
    // open with a flat run of empty pre-launch days.
    const series = [];
    for (let i = days - 1; i >= 0; i--) {
      const day = dayStr(now - i * 86400000);
      if (day < launchDay) continue;
      series.push({ day: day, count: byDay[day] || 0, visits: pv.byDay[day] || 0 });
    }

    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({
      ok: true,
      days,
      launchAt: launchAt,
      truncated: total >= CAP,
      total,
      surveyComplete,
      surveyRate: total ? +(surveyComplete / total).toFixed(3) : 0,
      usedReferral,
      referralsGiven,
      visits: pv.total,
      byCountry: pv.byCountry,
      byDevice: pv.byDevice,
      byChannel: byChannel,
      byVariant: byVariant,
      byVariantVisits: pv.byVariant,
      variantSurvey: variantSurvey,
      byRegion: byRegion,
      topReferrers: referrers.slice(0, 5),
      series: series,
    });
  } catch (err) {
    console.error('[metrics] failed:', err);
    return res.status(500).json({ ok: false, reason: 'server' });
  }
};
