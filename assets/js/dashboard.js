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
// Dual line chart: website visits + signups per day, on one shared scale so the
// gap between the lines visualises the conversion journey. Pure inline SVG (CSP-safe).
const SVGNS = 'http://www.w3.org/2000/svg';
function svgEl(tag, attrs) {
  const n = document.createElementNS(SVGNS, tag);
  Object.keys(attrs || {}).forEach((k) => n.setAttribute(k, attrs[k]));
  return n;
}
// Hover readout for a line chart: a vertical guide + tooltip showing the value
// of the nearest day. fmt(dayDatum) -> plain string. CSP-safe (no inline JS).
function attachLineHover(svg, container, series, fmt) {
  const n = series.length;
  if (!n) return;
  container.style.position = 'relative';
  const guide = el('div', 'trend-guide'); guide.style.display = 'none';
  const tip = el('div', 'trend-tip'); tip.style.display = 'none';
  container.appendChild(guide);
  container.appendChild(tip);
  svg.addEventListener('mousemove', (e) => {
    const sr = svg.getBoundingClientRect();
    const cr = container.getBoundingClientRect();
    let frac = (e.clientX - sr.left) / sr.width;
    frac = Math.max(0, Math.min(1, frac));
    const d = series[Math.round(frac * (n - 1))];
    tip.textContent = fmt(d);
    const px = e.clientX - cr.left;
    tip.style.left = px + 'px';
    tip.style.top = svg.offsetTop + 'px';
    guide.style.left = px + 'px';
    guide.style.top = svg.offsetTop + 'px';
    guide.style.height = svg.offsetHeight + 'px';
    tip.style.display = 'block';
    guide.style.display = 'block';
  });
  svg.addEventListener('mouseleave', () => { tip.style.display = 'none'; guide.style.display = 'none'; });
}
function renderTrend(series) {
  const chart = $('chart');
  chart.textContent = '';
  chart.style.display = 'block';
  chart.style.height = 'auto';
  if (!series.length) { chart.appendChild(el('p', 'empty', 'No data yet.')); return; }

  const totV = series.reduce((s, d) => s + (d.visits || 0), 0);
  const totS = series.reduce((s, d) => s + (d.count || 0), 0);

  // Legend.
  const legend = el('div', 'trend-legend');
  const item = (color, label) => {
    const w = el('span', 'tl-item');
    const dot = el('span', 'tl-dot'); dot.style.background = color;
    w.appendChild(dot); w.appendChild(el('span', null, label));
    return w;
  };
  legend.appendChild(item('#9fb8c0', 'Website visits (' + totV + ')'));
  legend.appendChild(item('#0e4754', 'Signups (' + totS + ')'));
  chart.appendChild(legend);

  // SVG line plot, stretched to container width (non-scaling strokes keep lines crisp).
  const W = 1000, H = 200, padL = 6, padR = 6, padT = 12, padB = 6;
  const n = series.length;
  const maxY = Math.max(1, Math.max.apply(null, series.map((d) => Math.max(d.visits || 0, d.count || 0))));
  const x = (i) => (n === 1 ? W / 2 : padL + (i / (n - 1)) * (W - padL - padR));
  const y = (v) => padT + (1 - v / maxY) * (H - padT - padB);
  const svg = svgEl('svg', { viewBox: '0 0 ' + W + ' ' + H, preserveAspectRatio: 'none' });
  svg.style.width = '100%'; svg.style.height = '200px'; svg.style.display = 'block';
  const line = (key, color, wdth) => svgEl('polyline', {
    points: series.map((d, i) => x(i) + ',' + y(d[key] || 0)).join(' '),
    fill: 'none', stroke: color, 'stroke-width': wdth,
    'stroke-linejoin': 'round', 'stroke-linecap': 'round', 'vector-effect': 'non-scaling-stroke',
  });
  svg.appendChild(line('visits', '#9fb8c0', 2));
  svg.appendChild(line('count', '#0e4754', 2.5));
  chart.appendChild(svg);

  // X-axis date labels, thinned to ~8 and aligned under the points.
  const labels = el('div', 'trend-x');
  const every = Math.max(1, Math.ceil(n / 8));
  series.forEach((d, i) => {
    labels.appendChild(el('span', null, (n - 1 - i) % every === 0 ? d.day.slice(5) : ''));
  });
  chart.appendChild(labels);

  attachLineHover(svg, chart, series, (d) =>
    d.day.slice(5) + '  ·  Visits ' + (d.visits || 0) + '  ·  Signups ' + (d.count || 0));
}

// Conversion rate (signups ÷ visits) per day, with a dashed 20% goal line.
function renderConvTrend(series) {
  const chart = $('conv-chart');
  if (!chart) return;
  chart.textContent = '';
  chart.style.display = 'block';
  chart.style.height = 'auto';
  const pts = series
    .map((d, i) => (d.visits > 0 ? { i: i, v: Math.min(1, d.count / d.visits) } : null))
    .filter(Boolean);
  if (!pts.length) { chart.appendChild(el('p', 'empty', 'No data yet.')); return; }

  const legend = el('div', 'trend-legend');
  const item = (color, label, dashed) => {
    const w = el('span', 'tl-item');
    const dot = el('span', 'tl-dot');
    if (dashed) { dot.style.background = 'none'; dot.style.border = '2px dashed ' + color; }
    else { dot.style.background = color; }
    w.appendChild(dot); w.appendChild(el('span', null, label));
    return w;
  };
  legend.appendChild(item('#0e4754', 'Conversion rate'));
  legend.appendChild(item('#c98a2b', '20% goal', true));
  chart.appendChild(legend);

  const W = 1000, H = 200, padL = 6, padR = 6, padT = 12, padB = 6;
  const n = series.length;
  const maxY = Math.max(0.25, Math.max.apply(null, pts.map((p) => p.v))) * 1.1;
  const x = (i) => (n === 1 ? W / 2 : padL + (i / (n - 1)) * (W - padL - padR));
  const y = (v) => padT + (1 - v / maxY) * (H - padT - padB);
  const svg = svgEl('svg', { viewBox: '0 0 ' + W + ' ' + H, preserveAspectRatio: 'none' });
  svg.style.width = '100%'; svg.style.height = '200px'; svg.style.display = 'block';
  if (0.2 <= maxY) {
    svg.appendChild(svgEl('line', {
      x1: 0, y1: y(0.2), x2: W, y2: y(0.2), stroke: '#c98a2b', 'stroke-width': 1.5,
      'stroke-dasharray': '6 5', 'vector-effect': 'non-scaling-stroke',
    }));
  }
  svg.appendChild(svgEl('polyline', {
    points: pts.map((p) => x(p.i) + ',' + y(p.v)).join(' '),
    fill: 'none', stroke: '#0e4754', 'stroke-width': 2.5,
    'stroke-linejoin': 'round', 'stroke-linecap': 'round', 'vector-effect': 'non-scaling-stroke',
  }));
  chart.appendChild(svg);

  const labels = el('div', 'trend-x');
  const every = Math.max(1, Math.ceil(n / 8));
  series.forEach((d, i) => {
    labels.appendChild(el('span', null, (n - 1 - i) % every === 0 ? d.day.slice(5) : ''));
  });
  chart.appendChild(labels);

  attachLineHover(svg, chart, series, (d) =>
    d.day.slice(5) + '  ·  ' + (d.visits > 0 ? pct1(Math.min(1, d.count / d.visits)) : 'no visits'));
}

// A/B per arm: visit→signup conversion (owned signups ÷ owned first-party
// visits), with the visit count shown small beside it. Falls back to signup
// counts if visits aren't recorded yet.
function renderVariants(byVariant, views) {
  const wrap = $('variants');
  wrap.textContent = '';
  views = views || {};
  const keys = ['A', 'B'].filter((k) => (k in byVariant) || views[k]);
  if (!keys.length) {
    wrap.appendChild(el('p', 'empty', 'No signups yet.'));
    return;
  }
  // Pick one display mode for the whole panel so both arms stay comparable.
  // If any arm has first-party visits, show the conversion rate for every arm
  // (a visit-less arm reads '—' but still shows its signup/visit counts);
  // otherwise fall back to raw signup counts for every arm.
  const haveVisits = keys.some((k) => (views[k] || 0) > 0);
  keys.forEach((k) => {
    const signups = byVariant[k] || 0;
    const v = views[k] || 0;
    const c = el('div', 'card');
    c.appendChild(el('div', 'label', 'Variant ' + k));
    const value = el('div', 'value');
    if (haveVisits) {
      value.appendChild(document.createTextNode(v > 0 ? pct1(Math.min(1, signups / v)) : '—'));
      value.appendChild(el('span', 'sub-stat', signups + ' / ' + v + ' visits'));
    } else {
      value.appendChild(document.createTextNode(String(signups)));
      value.appendChild(el('span', 'sub-stat', 'signups'));
    }
    c.appendChild(value);
    c.appendChild(el('div', 'note', VARIANT_COPY[k] || ''));
    wrap.appendChild(c);
  });
}

// Conversion per traffic channel: channel · signups/visits · rate.
function renderChannelConv(list) {
  const wrap = $('by-channel');
  wrap.textContent = '';
  if (!list || !list.length) {
    wrap.appendChild(el('p', 'empty', 'No data yet.'));
    return;
  }
  list.forEach((r) => {
    const row = el('div', 'statrow');
    const left = el('div', 'sk', r.channel);
    left.appendChild(el('span', 'chan-sub', '  ' + r.signups + '/' + r.visits));
    row.appendChild(left);
    row.appendChild(el('div', 'sv', pct1(r.rate)));
    wrap.appendChild(row);
  });
}

// Country names for the common codes; fall back to the raw code.
const COUNTRY_NAMES = { CA: 'Canada', US: 'United States', GB: 'United Kingdom', unknown: 'Unknown' };

function render(d) {
  const days = d.days || getDays();
  const visits = typeof d.visits === 'number' ? d.visits : null;

  const chartTitle = $('chart-title');
  if (chartTitle) chartTitle.textContent = 'Visits & signups · last ' + days + ' days';
  const convTitle = $('conv-title');
  if (convTitle) convTitle.textContent = 'Visit → signup rate · last ' + days + ' days';

  // Headline KPIs, all owned / first-party data.
  const cards = $('cards');
  cards.textContent = '';
  cards.appendChild(card('Total website visits', visits != null ? String(visits) : '—'));
  cards.appendChild(card('Total SMS signups', String(d.total)));
  // Accurate conversion: real signups ÷ first-party visits. Goal is ≥20%.
  const convRate = visits ? d.total / visits : null;
  const conv = card('Visit → signup rate', convRate != null ? pct1(convRate) : '—');
  if (convRate != null) {
    const goal = el('div', 'note ' + (convRate >= 0.2 ? 'good' : 'bad'),
      convRate >= 0.2 ? 'on target (≥20%)' : 'below 20% goal');
    conv.appendChild(goal);
  }
  cards.appendChild(conv);

  renderTrend(d.series || []);
  renderConvTrend(d.series || []);
  renderVariants(d.byVariant || {}, d.byVariantVisits || {});

  // Traffic-source panels exclude the catch-all 'Referral' bucket.
  const channels = (d.byChannel || []).filter((r) => r.channel !== 'Referral');
  renderChannelConv(channels);

  // Visits by traffic source: raw visit volume per channel (first-party).
  // channels is already sorted by visits desc; show arms with visits.
  statList($('visits-by-channel'), channels
    .filter((r) => r.visits > 0)
    .map((r) => ({ k: r.channel, v: String(r.visits) })));

  // Visit distributions (first-party).
  statList($('by-device'), Object.keys(d.byDevice || {})
    .sort((a, b) => d.byDevice[b] - d.byDevice[a])
    .map((k) => ({ k: k.charAt(0).toUpperCase() + k.slice(1), v: String(d.byDevice[k]) })));
  statList($('by-country'), Object.keys(d.byCountry || {})
    .sort((a, b) => d.byCountry[b] - d.byCountry[a])
    .map((k) => ({ k: COUNTRY_NAMES[k] || k, v: String(d.byCountry[k]) })));

  // Referrals card (sits next to top referrers).
  statList($('referral-stats'), [
    { k: 'Referral signups', v: String(d.usedReferral) },
    { k: 'Referrals given', v: String(d.referralsGiven) },
  ]);
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
