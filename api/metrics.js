/**
 * GET /api/metrics
 *
 * Admin-only feed for the owned-data analytics dashboard (/dashboard).
 * Aggregates the waitlist collection in memory and returns COUNTS ONLY,
 * no phone numbers or other PII ever leave Firestore here.
 *
 * Auth: Authorization: Bearer <DASHBOARD_TOKEN>
 *   DASHBOARD_TOKEN is an env var set in the Vercel dashboard. If it is not
 *   set the endpoint returns 503 (so the dashboard can never be left open).
 *
 * Response (200):
 *   { ok, total, surveyComplete, surveyRate, usedReferral, referralsGiven,
 *     bySource, byRegion, byVariant, variantSurvey, topReferrers, series, truncated }
 */
const crypto = require('crypto');
const { db } = require('./_lib/firestore');
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

// Pull the GA4 funnel via the Analytics Data API (last 28 days), once per
// dashboard load. Reuses the Firebase service account (which must be granted
// Viewer on the GA4 property). Returns null if GA4_PROPERTY_ID isn't set or the
// call fails, so the dashboard still works without it. Not real-time: GA4
// processed data lags ~a day, which is fine for an admin refresh.
const GA_EVENTS = [
  'heroView', 'fieldFocus', 'submitAttempt', 'submitSuccess', 'surveyComplete',
  'ctaClick', 'scrollDepth', 'sectionView',
];
// Order top-level sections so the "section reach" panel reads top→bottom.
const SECTION_ORDER = ['top', 'how-section', 'what-it-is', 'waitlist', 'team', 'faq'];

async function fetchGa4() {
  const propId = process.env.GA4_PROPERTY_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const privateKey = (process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n');
  if (!propId || !clientEmail || !privateKey) return null;

  const { JWT } = require('google-auth-library');
  const client = new JWT({
    email: clientEmail,
    key: privateKey,
    scopes: ['https://www.googleapis.com/auth/analytics.readonly'],
  });
  const { token } = await client.getAccessToken();
  const url =
    'https://analyticsdata.googleapis.com/v1beta/properties/' +
    encodeURIComponent(propId) +
    ':runReport';

  // Generic runReport: count eventCount over `dimensions`, restricted to the
  // given event names. Throws on non-2xx so callers can try/catch per query.
  const run = async (dimensions, eventNames) => {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        dateRanges: [{ startDate: '28daysAgo', endDate: 'today' }],
        metrics: [{ name: 'eventCount' }],
        dimensions: dimensions,
        dimensionFilter: {
          filter: { fieldName: 'eventName', inListFilter: { values: eventNames } },
        },
        limit: 250,
      }),
    });
    if (!resp.ok) throw new Error('ga4 ' + resp.status + ': ' + (await resp.text()).slice(0, 180));
    return resp.json();
  };
  const val = (r, i) => (r.dimensionValues[i] && r.dimensionValues[i].value) || '';
  const cnt = (r) => Number(r.metricValues[0].value) || 0;
  const rate = (signups, views) => (views ? +(signups / views).toFixed(4) : 0);

  // Pivot eventName × <dim> rows into [{ key, views, signups, rate }], desc by views.
  const pivot = (rows) => {
    const m = {};
    (rows || []).forEach((r) => {
      const ev = val(r, 0);
      const key = val(r, 1) || '(not set)';
      m[key] = m[key] || { views: 0, signups: 0 };
      if (ev === 'heroView') m[key].views += cnt(r);
      if (ev === 'submitSuccess') m[key].signups += cnt(r);
    });
    return Object.keys(m)
      .map((k) => ({ key: k, views: m[k].views, signups: m[k].signups, rate: rate(m[k].signups, m[k].views) }))
      .sort((a, b) => b.views - a.views);
  };

  // Funnel totals by event name.
  const totals = await run([{ name: 'eventName' }], GA_EVENTS);
  const counts = {};
  (totals.rows || []).forEach((r) => { counts[val(r, 0)] = cnt(r); });
  const num = (k) => counts[k] || 0;
  const site = {
    heroView: num('heroView'),
    fieldFocus: num('fieldFocus'),
    submitAttempt: num('submitAttempt'),
    submitSuccess: num('submitSuccess'),
    surveyComplete: num('surveyComplete'),
    visitToWaitlistRate: rate(num('submitSuccess'), num('heroView')),
    perVariant: null,
    cta: null,
    scrollDepth: null,
    bySource: null,
    byDevice: null,
    sections: null,
    days: 28,
  };

  // Per-variant view→signup rate. Needs the `variant` custom dimension
  // registered in GA4; if it isn't, this throws and we just skip it.
  try {
    const byVar = pivot((await run(
      [{ name: 'eventName' }, { name: 'customEvent:variant' }],
      ['heroView', 'submitSuccess'],
    )).rows);
    const find = (k) => byVar.find((r) => r.key === k) || { views: 0, signups: 0, rate: 0 };
    site.perVariant = { A: find('A'), B: find('B') };
  } catch (e) { /* variant dimension not registered yet */ }

  // Waitlist rate by traffic source (channel group is built-in, no setup).
  try {
    site.bySource = pivot((await run(
      [{ name: 'eventName' }, { name: 'sessionDefaultChannelGroup' }],
      ['heroView', 'submitSuccess'],
    )).rows).slice(0, 8);
  } catch (e) { /* leave null */ }

  // Mobile vs desktop conversion (deviceCategory is built-in).
  try {
    site.byDevice = pivot((await run(
      [{ name: 'eventName' }, { name: 'deviceCategory' }],
      ['heroView', 'submitSuccess'],
    )).rows);
  } catch (e) { /* leave null */ }

  // Hero CTA click rate. Needs the `location` custom dimension registered.
  try {
    const rows = (await run([{ name: 'customEvent:location' }], ['ctaClick'])).rows || [];
    let total = 0;
    let hero = 0;
    rows.forEach((r) => { const c = cnt(r); total += c; if (val(r, 0) === 'hero') hero += c; });
    site.cta = { total, hero, heroRate: rate(hero, site.heroView) };
  } catch (e) { /* location dimension not registered yet */ }

  // Scroll-depth distribution. Needs the `depth` custom dimension registered.
  try {
    const rows = (await run([{ name: 'customEvent:depth' }], ['scrollDepth'])).rows || [];
    const dist = {};
    rows.forEach((r) => { dist[val(r, 0)] = (dist[val(r, 0)] || 0) + cnt(r); });
    site.scrollDepth = ['25', '50', '75', '100'].map((d) => ({ depth: d, count: dist[d] || 0 }));
  } catch (e) { /* depth dimension not registered yet */ }

  // Section reach (exit approximation). Needs the `section` custom dimension.
  try {
    const rows = (await run([{ name: 'customEvent:section' }], ['sectionView'])).rows || [];
    const m = {};
    rows.forEach((r) => { m[val(r, 0)] = (m[val(r, 0)] || 0) + cnt(r); });
    const base = site.heroView || m.top || 1;
    const ordered = SECTION_ORDER.filter((s) => s in m).concat(
      Object.keys(m).filter((s) => SECTION_ORDER.indexOf(s) === -1),
    );
    site.sections = ordered.map((s) => ({
      section: s,
      views: m[s],
      pctOfHero: +(m[s] / base).toFixed(4),
    }));
  } catch (e) { /* section dimension not registered yet */ }

  return site;
}

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ ok: false, reason: 'method' });
  }

  const token = process.env.DASHBOARD_TOKEN || '';
  if (!token) return res.status(503).json({ ok: false, reason: 'not-configured' });

  const auth = String(req.headers.authorization || '');
  const bearer = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!safeEqual(bearer, token)) {
    return res.status(401).json({ ok: false, reason: 'unauthorized' });
  }

  const ip = clientIp(req);
  const rl = await rateLimit('rl:metrics:' + (hashIp(ip) || ip || 'unknown'), {
    max: 30,
    windowSec: 60,
  });
  if (!rl.allowed) {
    res.setHeader('Retry-After', '60');
    return res.status(429).json({ ok: false, reason: 'rate-limited' });
  }

  try {
    const database = db();
    const CAP = 5000; // pre-launch volumes are tiny; cap keeps the read bounded.
    const snap = await database
      .collection('waitlist')
      .select(
        'source',
        'region',
        'variant',
        'surveyComplete',
        'usedReferral',
        'referralCount',
        'referralCode',
        'createdAt',
      )
      .limit(CAP)
      .get();

    const bySource = {};
    const byRegion = {};
    const byVariant = {};
    const variantSurvey = {}; // variant -> # who also completed the survey
    const byDay = {};
    const referrers = [];
    let total = 0;
    let surveyComplete = 0;
    let usedReferral = 0;
    let referralsGiven = 0;

    snap.forEach((doc) => {
      const d = doc.data() || {};
      total++;

      const src = d.source || 'unknown';
      bySource[src] = (bySource[src] || 0) + 1;

      const reg = d.region || 'unknown';
      byRegion[reg] = (byRegion[reg] || 0) + 1;

      // Only A/B count toward the test. Signups with no (or any other) variant
      // predate the A/B split, so they're excluded from the variant breakdown.
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

      const ts = d.createdAt;
      if (ts && typeof ts.toDate === 'function') {
        const day = ts.toDate().toISOString().slice(0, 10);
        byDay[day] = (byDay[day] || 0) + 1;
      }
    });

    referrers.sort((a, b) => b.count - a.count);

    // GA4 funnel (best-effort, on-demand). Never breaks the owned-data response.
    let site = null;
    try {
      site = await fetchGa4();
    } catch (e) {
      console.warn('[metrics] GA4 fetch failed:', e && e.message);
    }

    // Last 14 days as a dense series (UTC), zero-filled so the chart is stable.
    const series = [];
    const now = Date.now();
    for (let i = 13; i >= 0; i--) {
      const day = new Date(now - i * 86400000).toISOString().slice(0, 10);
      series.push({ day, count: byDay[day] || 0 });
    }

    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({
      ok: true,
      truncated: total >= CAP,
      total,
      surveyComplete,
      surveyRate: total ? +(surveyComplete / total).toFixed(3) : 0,
      usedReferral,
      referralsGiven,
      bySource,
      byRegion,
      byVariant,
      variantSurvey,
      topReferrers: referrers.slice(0, 5),
      series,
      site,
    });
  } catch (err) {
    console.error('[metrics] failed:', err);
    return res.status(500).json({ ok: false, reason: 'server' });
  }
};
