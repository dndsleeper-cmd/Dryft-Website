/* =================================================================
   Dryft internal dashboard. Reads /api/metrics (admin-token gated) and
   renders owned waitlist + survey data. No external chart libs (CSP-safe).
   The token is held in localStorage and sent as a Bearer header.
================================================================= */
'use strict';

const TOKEN_KEY = 'dryft_dash_token';
const $ = (id) => document.getElementById(id);

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

// A bar row: label, proportional fill, right-aligned value, optional sub-note.
function bar(container, label, fillPct, value, note) {
  const row = el('div', 'row wide');
  row.appendChild(el('div', 'k', label));
  const track = el('div', 'track');
  const fill = el('div', 'fill');
  fill.style.width = Math.max(0, Math.min(100, Math.round(fillPct))) + '%';
  track.appendChild(fill);
  row.appendChild(track);
  row.appendChild(el('div', 'v', value));
  container.appendChild(row);
  if (note) {
    const n = el('div', 'hint', note);
    n.style.margin = '-.15rem 0 .6rem';
    container.appendChild(n);
  }
}

// Pretty section labels for the "where attention drops" panel.
const SECTION_LABELS = {
  top: 'Hero',
  'how-section': 'How it works',
  'what-it-is': 'What it is',
  waitlist: 'Waitlist',
  team: 'Team',
  faq: 'FAQ / trust',
};

// Horizontal bar rows from a {key: count} map, sorted desc.
function barRows(container, map, order) {
  container.textContent = '';
  const entries = Object.keys(map).map((k) => [k, map[k]]);
  if (order) {
    entries.sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0]));
  } else {
    entries.sort((a, b) => b[1] - a[1]);
  }
  if (!entries.length) {
    container.appendChild(el('p', 'empty', 'No data yet.'));
    return;
  }
  const max = Math.max.apply(null, entries.map((e) => e[1])) || 1;
  entries.forEach(([k, v]) => {
    const row = el('div', 'row');
    row.appendChild(el('div', 'k', k));
    const track = el('div', 'track');
    const fill = el('div', 'fill');
    fill.style.width = Math.round((v / max) * 100) + '%';
    track.appendChild(fill);
    row.appendChild(track);
    row.appendChild(el('div', 'v', String(v)));
    container.appendChild(row);
  });
}

function renderChart(series) {
  const chart = $('chart');
  chart.textContent = '';
  const max = Math.max.apply(null, series.map((d) => d.count)) || 1;
  series.forEach((d) => {
    const col = el('div', 'col');
    col.title = d.day + ': ' + d.count;
    const bar = el('div', 'cbar');
    bar.style.height = Math.round((d.count / max) * 100) + '%';
    col.appendChild(bar);
    col.appendChild(el('div', 'clab', d.day.slice(8))); // day-of-month
    chart.appendChild(col);
  });
}

function renderVariants(byVariant, variantSurvey) {
  const wrap = $('variants');
  wrap.textContent = '';
  // Only the live A/B arms; pre-test signups (no variant) are already excluded.
  const keys = ['A', 'B'].filter((k) => k in byVariant);
  if (!keys.length) {
    wrap.appendChild(el('p', 'empty', 'No signups yet.'));
    return;
  }
  const max = Math.max.apply(null, keys.map((k) => byVariant[k])) || 1;
  keys.forEach((k) => {
    const signups = byVariant[k] || 0;
    const surveys = variantSurvey[k] || 0;
    const row = el('div', 'row');
    row.appendChild(el('div', 'k', 'Variant ' + k));
    const track = el('div', 'track');
    const fill = el('div', 'fill');
    fill.style.width = Math.round((signups / max) * 100) + '%';
    track.appendChild(fill);
    row.appendChild(track);
    row.appendChild(el('div', 'v', String(signups)));
    wrap.appendChild(row);
    const head = el('div', 'hint');
    head.style.margin = '-.2rem 0 0';
    head.textContent = '“' + (VARIANT_COPY[k] || '') + '”';
    wrap.appendChild(head);
    const note = el('div', 'hint');
    note.style.margin = '.05rem 0 .6rem';
    note.textContent = surveys + ' completed the survey';
    wrap.appendChild(note);
  });
}

function renderReferrers(list) {
  const wrap = $('referrers');
  wrap.textContent = '';
  if (!list || !list.length) {
    wrap.appendChild(el('p', 'empty', 'No referrals yet.'));
    return;
  }
  const max = Math.max.apply(null, list.map((r) => r.count)) || 1;
  list.forEach((r) => {
    const row = el('div', 'row');
    row.appendChild(el('div', 'k', r.code));
    const track = el('div', 'track');
    const fill = el('div', 'fill');
    fill.style.width = Math.round((r.count / max) * 100) + '%';
    track.appendChild(fill);
    row.appendChild(track);
    row.appendChild(el('div', 'v', String(r.count)));
    wrap.appendChild(row);
  });
}

// Declare the A/B winner from owned signups. Valid because the hero split is
// ~50/50, so with roughly equal views, more signups = higher conversion.
function renderVerdict(byVariant) {
  const wrap = $('ab-verdict');
  wrap.textContent = '';
  wrap.classList.remove('muted-verdict');
  const a = byVariant.A || 0;
  const b = byVariant.B || 0;
  if (a + b < 10) {
    wrap.classList.add('muted-verdict');
    wrap.textContent = 'Not enough signups yet to call a winner (aim for ~10+ per variant).';
    return;
  }
  if (a === b) {
    wrap.textContent = 'Dead even so far (' + a + ' vs ' + b + ').';
    return;
  }
  const lead = a > b ? 'A' : 'B';
  const hi = Math.max(a, b);
  const lo = Math.min(a, b);
  const pct = lo ? Math.round(((hi - lo) / lo) * 100) : 100;
  wrap.textContent = 'Variant ' + lead + ' is winning by ' + pct + '% (' + hi + ' vs ' + lo + ' signups).';
}

// GA4 visitor funnel (heroView -> ... -> surveyComplete) with each step as a
// share of hero views, so the biggest gap is obvious.
function renderFunnel(site) {
  const wrap = $('funnel');
  wrap.textContent = '';
  if (!site) {
    wrap.appendChild(
      el('p', 'empty', 'GA4 not connected yet. Set GA4_PROPERTY_ID + grant the service account Viewer on the property.'),
    );
    return;
  }
  const steps = [
    ['Hero views', site.heroView],
    ['Field focus', site.fieldFocus],
    ['Submit attempt', site.submitAttempt],
    ['Submit success', site.submitSuccess],
    ['Survey complete', site.surveyComplete],
  ];
  const base = site.heroView || Math.max.apply(null, steps.map((s) => s[1])) || 1;
  steps.forEach(([k, v]) => {
    const row = el('div', 'row wide');
    row.appendChild(el('div', 'k', k));
    const track = el('div', 'track');
    const fill = el('div', 'fill');
    fill.style.width = Math.round((v / base) * 100) + '%';
    track.appendChild(fill);
    row.appendChild(track);
    row.appendChild(el('div', 'v', String(v)));
    wrap.appendChild(row);
  });
}

// View->signup conversion rate per A/B variant (from GA4).
function renderVariantConv(site) {
  const wrap = $('variant-conv');
  wrap.textContent = '';
  if (!site || !site.perVariant) return;
  const head = el('div', 'hint', 'Conversion rate per variant (signup ÷ hero view)');
  head.style.marginBottom = '.5rem';
  wrap.appendChild(head);
  const a = site.perVariant.A || { views: 0, signups: 0, rate: 0 };
  const b = site.perVariant.B || { views: 0, signups: 0, rate: 0 };
  const max = Math.max(a.rate, b.rate, 0.0001);
  [['A', a], ['B', b]].forEach(function (pair) {
    const label = pair[0];
    const dd = pair[1];
    const row = el('div', 'row wide');
    row.appendChild(el('div', 'k', 'Variant ' + label));
    const track = el('div', 'track');
    const fill = el('div', 'fill');
    fill.style.width = Math.round((dd.rate / max) * 100) + '%';
    track.appendChild(fill);
    row.appendChild(track);
    row.appendChild(el('div', 'v', (dd.rate * 100).toFixed(1) + '%'));
    wrap.appendChild(row);
    const head = el('div', 'hint', '“' + (VARIANT_COPY[label] || '') + '”');
    head.style.margin = '-.15rem 0 0';
    wrap.appendChild(head);
    const note = el('div', 'hint', dd.signups + ' signups / ' + dd.views + ' views');
    note.style.margin = '.05rem 0 .6rem';
    wrap.appendChild(note);
  });
}

// Visit→signup rate per traffic channel (GA4 sessionDefaultChannelGroup).
function renderBySource(site) {
  const wrap = $('by-source');
  wrap.textContent = '';
  const list = site && site.bySource;
  if (!list || !list.length) {
    wrap.appendChild(el('p', 'empty', site ? 'No source data yet.' : 'GA4 not connected yet.'));
    return;
  }
  const max = Math.max.apply(null, list.map((r) => r.rate)) || 0.0001;
  list.forEach((r) => {
    bar(wrap, r.key, (r.rate / max) * 100, pct1(r.rate), r.signups + ' signups / ' + r.views + ' views');
  });
}

// Visit→signup rate split by device category (GA4 deviceCategory).
function renderByDevice(site) {
  const wrap = $('by-device');
  wrap.textContent = '';
  const list = site && site.byDevice;
  if (!list || !list.length) {
    wrap.appendChild(el('p', 'empty', site ? 'No device data yet.' : 'GA4 not connected yet.'));
    return;
  }
  const max = Math.max.apply(null, list.map((r) => r.rate)) || 0.0001;
  list.forEach((r) => {
    const label = r.key.charAt(0).toUpperCase() + r.key.slice(1);
    bar(wrap, label, (r.rate / max) * 100, pct1(r.rate), r.signups + ' signups / ' + r.views + ' views');
  });
}

// Scroll-depth distribution, each depth as a share of the deepest (25%) bucket.
function renderScrollDepth(site) {
  const wrap = $('scroll-depth');
  wrap.textContent = '';
  const list = site && site.scrollDepth;
  if (!list || !list.length) {
    wrap.appendChild(el('p', 'empty', site ? 'No scroll data yet (register the `depth` dimension).' : 'GA4 not connected yet.'));
    return;
  }
  const base = (list[0] && list[0].count) || Math.max.apply(null, list.map((r) => r.count)) || 1;
  list.forEach((r) => {
    const share = base ? r.count / base : 0;
    bar(wrap, r.depth + '% depth', share * 100, String(r.count), pct1(share) + ' of those who reached 25%');
  });
}

// Section reach: share of visitors whose screen reached each section, top→bottom.
function renderSections(site) {
  const wrap = $('sections');
  wrap.textContent = '';
  const list = site && site.sections;
  if (!list || !list.length) {
    wrap.appendChild(el('p', 'empty', site ? 'No section data yet (register the `section` dimension).' : 'GA4 not connected yet.'));
    return;
  }
  list.forEach((r) => {
    const label = SECTION_LABELS[r.section] || r.section;
    bar(wrap, label, r.pctOfHero * 100, pct1(r.pctOfHero), String(r.views) + ' reached');
  });
}

function render(d) {
  const cards = $('cards');
  cards.textContent = '';
  cards.appendChild(card('Total signups', String(d.total)));
  cards.appendChild(
    card('Survey completed', String(d.surveyComplete), Math.round((d.surveyRate || 0) * 100) + '% of signups'),
  );
  cards.appendChild(card('Referral signups', String(d.usedReferral), 'joined via a code'));
  cards.appendChild(card('Referrals given', String(d.referralsGiven), 'total invites credited'));

  // GA4-derived headline rates (only when GA4 is connected).
  if (d.site) {
    cards.appendChild(card(
      'Visit → waitlist rate',
      pct1(d.site.visitToWaitlistRate),
      d.site.submitSuccess + ' signups / ' + d.site.heroView + ' hero views',
    ));
    if (d.site.cta) {
      cards.appendChild(card(
        'Hero CTA click rate',
        pct1(d.site.cta.heroRate),
        d.site.cta.hero + ' hero CTA clicks / ' + d.site.heroView + ' hero views',
      ));
    }
  }

  renderChart(d.series || []);
  renderFunnel(d.site || null);
  renderVariantConv(d.site || null);
  renderBySource(d.site || null);
  renderByDevice(d.site || null);
  renderScrollDepth(d.site || null);
  renderSections(d.site || null);
  renderVerdict(d.byVariant || {});
  renderVariants(d.byVariant || {}, d.variantSurvey || {});
  barRows($('sources'), d.bySource || {}, ['hero', 'final', 'referral']);
  barRows($('regions'), d.byRegion || {});
  renderReferrers(d.topReferrers || []);

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
    const resp = await fetch('/api/metrics', {
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

load();
