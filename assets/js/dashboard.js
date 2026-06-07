/* =================================================================
   Dryft internal dashboard. Reads /api/metrics (admin-token gated) and
   renders a clean executive view: headline numbers/rates as tiles, plus
   compact stat lists. No external chart libs (CSP-safe). The token is held
   in localStorage and sent as a Bearer header.
================================================================= */
'use strict';

const TOKEN_KEY = 'dryft_dash_token';
const RANGE_KEY = 'dryft_dash_days';
const ALLOWED_DAYS = [7, 14, 30, 90, 365];
const $ = (id) => document.getElementById(id);

// Selected timeline window (days), from the dropdown. Persisted so a refresh
// keeps the chosen range. Defaults to 30.
function getDays() {
  const sel = $('range');
  const v = sel ? parseInt(sel.value, 10) : 30;
  return ALLOWED_DAYS.indexOf(v) !== -1 ? v : 30;
}

// The two hero headlines under test, so the dashboard can label which message is
// A vs B. Keep in sync with AB_VARIANTS in assets/js/main.js.
const VARIANT_COPY = {
  A: 'the app for people who hate budgeting.',
  B: 'you were never going to budget anyway.',
};

const gate = $('gate');
const app = $('app');
const actions = $('actions');
const msg = $('msg');

function getToken() {
  try { return localStorage.getItem(TOKEN_KEY) || ''; } catch (_) { return ''; }
}
function setToken(t) {
  try { localStorage.setItem(TOKEN_KEY, t); } catch (_) {}
}
function clearToken() {
  try { localStorage.removeItem(TOKEN_KEY); } catch (_) {}
}

function showMessage(text, isErr) {
  msg.textContent = text || '';
  msg.className = 'msg' + (isErr ? ' err' : '');
}

function showGate(err) {
  gate.hidden = false;
  app.hidden = true;
  actions.hidden = true;
  if (err) showMessage(err, true); else showMessage('');
}

function showApp() {
  gate.hidden = true;
  app.hidden = false;
  actions.hidden = false;
}

// --- tiny render helpers ---------------------------------------------------
function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

// A KPI tile: title + big value, optional small sub-note.
function card(label, value, note) {
  const c = el('div', 'card');
  c.appendChild(el('div', 'label', label));
  c.appendChild(el('div', 'value', value));
  if (note) c.appendChild(el('div', 'note', note));
  return c;
}

// 0.1234 -> "12.3%"
function pct1(r) {
  return ((Number(r) || 0) * 100).toFixed(1) + '%';
}

// A clean stat list: rows of "label … value", no bars. items = [{k, v}].
function statList(container, items) {
  container.textContent = '';
  if (!items || !items.length) {
    container.appendChild(el('p', 'empty', 'No data yet.'));
    return;
  }
  items.forEach((it) => {
    const row = el('div', 'statrow');
    row.appendChild(el('div', 'sk', it.k));
    row.appendChild(el('div', 'sv', it.v));
    container.appendChild(row);
  });
}

// Signups trend, one bar per day across the selected window.
function renderChart(series) {
  const chart = $('chart');
  chart.textContent = '';
  const n = series.length;
  // Long ranges (90/365d) have many bars: tighten the gap so they don't overflow
  // and thin the labels to ~14 so they don't overlap.
  chart.style.gap = n > 60 ? '1px' : (n > 30 ? '2px' : '4px');
  const labelEvery = Math.max(1, Math.ceil(n / 14));
  const max = Math.max.apply(null, series.map((d) => d.count)) || 1;
  series.forEach((d, i) => {
    const col = el('div', 'col');
    col.title = d.day + ': ' + d.count;
    const cbar = el('div', 'cbar');
    cbar.style.height = Math.round((d.count / max) * 100) + '%';
    col.appendChild(cbar);
    // Label from the right edge so the most recent day is always labelled.
    const showLabel = (n - 1 - i) % labelEvery === 0;
    col.appendChild(el('div', 'clab', showLabel ? d.day.slice(5) : '')); // MM-DD
    chart.appendChild(col);
  });
}

// Visitor funnel as clean stat tiles: each step's count and share of visits.
function renderFunnel(site) {
  const wrap = $('funnel');
  wrap.textContent = '';
  if (!site) {
    wrap.appendChild(el('p', 'empty', 'GA4 not connected.'));
    return;
  }
  const base = site.heroView || 1;
  const steps = [
    ['Visits', site.heroView],
    ['Field focus', site.fieldFocus],
    ['Submit attempt', site.submitAttempt],
    ['Signups', site.submitSuccess],
    ['Survey complete', site.surveyComplete],
  ];
  steps.forEach(([k, v], i) => {
    wrap.appendChild(card(k, String(v), i === 0 ? '100% of visits' : pct1((v || 0) / base) + ' of visits'));
  });
}

// A/B arms as conversion-rate tiles (visit→signup), labelled by their headline.
// Needs GA4's per-variant data; falls back to raw signup counts otherwise.
function renderVariants(site, byVariant) {
  const wrap = $('variants');
  wrap.textContent = '';
  const pv = site && site.perVariant && (site.perVariant.A.views + site.perVariant.B.views) > 0
    ? site.perVariant : null;
  const keys = ['A', 'B'].filter((k) => (k in byVariant) || (pv && pv[k]));
  if (!keys.length) {
    wrap.appendChild(el('p', 'empty', 'No signups yet.'));
    return;
  }
  keys.forEach((k) => {
    const value = pv ? pct1(pv[k].rate) : String(byVariant[k] || 0);
    wrap.appendChild(card('Variant ' + k, value, VARIANT_COPY[k] || ''));
  });
}

// Conversion rate by device, as tiles.
function renderByDevice(site) {
  const wrap = $('by-device');
  wrap.textContent = '';
  const list = site && site.byDevice;
  if (!list || !list.length) {
    wrap.appendChild(el('p', 'empty', site ? 'No device data.' : 'GA4 not connected.'));
    return;
  }
  list.forEach((r) => {
    const label = r.key.charAt(0).toUpperCase() + r.key.slice(1);
    wrap.appendChild(card(label, pct1(r.rate)));
  });
}

function render(d) {
  const site = d.site || null;
  const days = d.days || getDays();

  // Reflect the selected window in the panel titles.
  const setTitle = (id, text) => { const n = $(id); if (n) n.textContent = text; };
  setTitle('chart-title', 'Signups · last ' + days + ' days');
  setTitle('funnel-title', 'Visitor funnel · last ' + days + ' days');

  // Headline KPIs (GA4 tiles show "—" until connected).
  const cards = $('cards');
  cards.textContent = '';
  cards.appendChild(card('Total website visits', site ? String(site.heroView) : '—'));
  cards.appendChild(card('Total SMS signups', String(d.total)));
  cards.appendChild(card('Visit → signup rate', site ? pct1(site.visitToWaitlistRate) : '—'));
  cards.appendChild(card('Hero CTA click rate', site && site.cta ? pct1(site.cta.heroRate) : '—'));
  cards.appendChild(card('Survey completion rate', pct1(d.surveyRate || 0)));
  cards.appendChild(card('Referral signups', String(d.usedReferral)));
  cards.appendChild(card('Referrals given', String(d.referralsGiven)));

  renderChart(d.series || []);
  renderFunnel(site);
  renderVariants(site, d.byVariant || {});
  renderByDevice(site);

  // Distributions as clean stat lists (no bars).
  statList($('by-source'), (site && site.bySource ? site.bySource : []).map(
    (r) => ({ k: r.key, v: pct1(r.rate) }),
  ));
  statList($('sources'), ['hero', 'final', 'referral']
    .filter((k) => d.bySource && k in d.bySource)
    .map((k) => ({ k: k, v: String(d.bySource[k]) })));
  statList($('regions'), Object.keys(d.byRegion || {})
    .sort((a, b) => d.byRegion[b] - d.byRegion[a])
    .map((k) => ({ k: k, v: String(d.byRegion[k]) })));
  statList($('referrers'), (d.topReferrers || []).map((r) => ({ k: r.code, v: String(r.count) })));

  showMessage(
    'Updated ' + new Date().toLocaleTimeString() + (d.truncated ? ' · showing first 5000 signups' : ''),
  );
}

async function load() {
  const token = getToken();
  if (!token) return showGate();
  showApp();
  showMessage('Loading…');
  try {
    const resp = await fetch('/api/metrics?days=' + getDays(), {
      headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' },
    });
    if (resp.status === 401) {
      clearToken();
      return showGate('That token was rejected. Try again.');
    }
    if (resp.status === 503) {
      return showGate('DASHBOARD_TOKEN is not set in Vercel yet. Add it, redeploy, then sign in.');
    }
    if (resp.status === 429) {
      return showMessage('Rate limited. Wait a minute and refresh.', true);
    }
    if (!resp.ok) {
      return showMessage('Server error (' + resp.status + '). Check Vercel logs.', true);
    }
    const data = await resp.json();
    if (!data || !data.ok) return showMessage('Unexpected response.', true);
    render(data);
  } catch (err) {
    showMessage('Network error: ' + (err && err.message ? err.message : 'failed to load'), true);
  }
}

// --- wire up ---------------------------------------------------------------
$('enter').addEventListener('click', () => {
  const v = $('token-input').value.trim();
  if (!v) return;
  setToken(v);
  load();
});
$('token-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('enter').click();
});
$('refresh').addEventListener('click', load);
$('logout').addEventListener('click', () => {
  clearToken();
  $('token-input').value = '';
  showGate();
});

// Timeline dropdown: restore the saved range, then reload on change.
(function initRange() {
  const sel = $('range');
  if (!sel) return;
  try {
    const saved = parseInt(localStorage.getItem(RANGE_KEY) || '', 10);
    if (ALLOWED_DAYS.indexOf(saved) !== -1) sel.value = String(saved);
  } catch (_) { /* ignore */ }
  sel.addEventListener('change', () => {
    try { localStorage.setItem(RANGE_KEY, sel.value); } catch (_) {}
    load();
  });
})();

load();
