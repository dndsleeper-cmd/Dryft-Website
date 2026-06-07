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
const GA_EVENTS = ['heroView', 'fieldFocus', 'submitAttempt', 'submitSuccess', 'surveyComplete'];
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
  const base = {
    dateRanges: [{ startDate: '28daysAgo', endDate: 'today' }],
    metrics: [{ name: 'eventCount' }],
    dimensionFilter: {
      filter: { fieldName: 'eventName', inListFilter: { values: GA_EVENTS } },
    },
    limit: 200,
  };
  const run = async (dimensions) => {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify(Object.assign({ dimensions: dimensions }, base)),
    });
    if (!resp.ok) throw new Error('ga4 ' + resp.status + ': ' + (await resp.text()).slice(0, 180));
    return resp.json();
  };

  // Funnel totals by event name.
  const totals = await run([{ name: 'eventName' }]);
  const counts = {};
  (totals.rows || []).forEach((r) => {
    counts[r.dimensionValues[0].value] = Number(r.metricValues[0].value) || 0;
  });
  const num = (k) => counts[k] || 0;
  const site = {
    heroView: num('heroView'),
    fieldFocus: num('fieldFocus'),
    submitAttempt: num('submitAttempt'),
    submitSuccess: num('submitSuccess'),
    surveyComplete: num('surveyComplete'),
    perVariant: null,
    days: 28,
  };

  // Per-variant view→signup rate. Needs the `variant` custom dimension to be
  // registered in GA4; if it isn't, this throws and we just skip it.
  try {
    const byVar = await run([{ name: 'eventName' }, { name: 'customEvent:variant' }]);
    const pv = {};
    (byVar.rows || []).forEach((r) => {
      const ev = r.dimensionValues[0].value;
      const va = r.dimensionValues[1].value || 'unknown';
      const c = Number(r.metricValues[0].value) || 0;
      pv[va] = pv[va] || { heroView: 0, submitSuccess: 0 };
      if (ev === 'heroView') pv[va].heroView += c;
      if (ev === 'submitSuccess') pv[va].submitSuccess += c;
    });
    const mk = (v) => {
      const d = pv[v] || { heroView: 0, submitSuccess: 0 };
      return {
        views: d.heroView,
        signups: d.submitSuccess,
        rate: d.heroView ? +(d.submitSuccess / d.heroView).toFixed(4) : 0,
      };
    };
    site.perVariant = { A: mk('A'), B: mk('B') };
  } catch (e) {
    /* variant custom dimension not registered yet, funnel totals still returned */
  }
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

      const v = d.variant || 'unknown';
      byVariant[v] = (byVariant[v] || 0) + 1;

      if (d.surveyComplete) {
        surveyComplete++;
        variantSurvey[v] = (variantSurvey[v] || 0) + 1;
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
