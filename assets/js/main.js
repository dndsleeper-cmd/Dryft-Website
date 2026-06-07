/* =================================================================
   Dryft, landing interactions
   - nav scroll state
   - scroll reveals
   - waitlist submission (CSP-friendly, honeypot + timing bot checks)
   - hero notification cascade
   - hero chat sequence
================================================================= */
'use strict';

const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const wait = (ms) => new Promise(r => setTimeout(r, ms));

/* ---------------- analytics: funnel events ----------------
   Fires Vercel Web Analytics custom events so we can see the funnel
   (field focus -> submit attempt -> submit success -> survey complete) and tell
   a bad ad from a bad page. window.va is the queue stub installed by the
   analytics <script> in <head>; calls made before it finishes loading are
   buffered. No-ops entirely if analytics is blocked or absent. */
// Display name -> GA4 event name (snake/camel, no spaces).
const EVENT_KEYS = {
  'Hero View': 'heroView',
  'Waitlist Field Focus': 'fieldFocus',
  'Waitlist Submit Attempt': 'submitAttempt',
  'Waitlist Submit Success': 'submitSuccess',
  'Survey Complete': 'surveyComplete',
  'CTA Click': 'ctaClick',
  'Scroll Depth': 'scrollDepth',
  'Section View': 'sectionView',
};
// Local/dev hosts must never pollute GA4 with our own views and funnel events.
// ga-bootstrap.js already skips loading gtag on these hosts; this is the explicit
// belt-and-suspenders guard so track() is a hard no-op locally even if a gtag
// stub or a real Measurement ID is present while testing. Keep in sync with the
// host list in ga-bootstrap.js.
const IS_LOCAL_HOST = (function () {
  const host = location.hostname;
  return (
    host === 'localhost' ||
    host === '127.0.0.1' ||
    host === '0.0.0.0' ||
    host === '' ||
    host.endsWith('.local')
  );
})();
// Funnel + view events go ONLY to GA4 (free, scalable, batched by Google). We
// deliberately do NOT write a row to our own DB per pageview/interaction, that
// would be a constant stream of Firestore writes (and a single-doc hotspot).
// The internal dashboard reads owned signup outcomes from Firestore on demand.
function track(name, data) {
  if (IS_LOCAL_HOST) return; // never count local/dev/preview traffic
  const variant = window.__dryftVariant || 'A';
  const key = EVENT_KEYS[name] || name.toLowerCase().replace(/\s+/g, '_');
  try {
    if (typeof window.gtag === 'function') {
      window.gtag('event', key, Object.assign({ variant: variant }, data || {}));
    }
  } catch (_) { /* analytics must never break the page */ }
}

/* ---------------- hero A/B test ----------------
   50/50 split between two hero messages, sticky per visitor via a 1-year cookie
   so a returning person always sees the same variant (and so repeat views don't
   pollute the test). The variant rides on every analytics event (above) and on
   the waitlist payload, so conversion can be compared per variant.
     A = identity claim     B = "feel seen" claim
   Default HTML is variant A (SEO + no-JS safe); variant B is swapped in here. */
const AB_VARIANTS = {
  A: {
    line1: 'the app for people',
    line2: 'who hate budgeting.',
    sub: 'Dryft pings you before you overspend. no constant logging, no strict budget.',
  },
  B: {
    line1: 'you were never going',
    line2: 'to budget anyway.',
    sub: 'so Dryft pings you before you overspend. no logging, no strict budget.',
  },
};
function assignVariant() {
  try {
    const m = document.cookie.match(/(?:^|;\s*)dryft_ab=([AB])(?:;|$)/);
    if (m) return m[1];
  } catch (_) { /* cookies blocked, fall through to a fresh roll */ }
  const v = Math.random() < 0.5 ? 'A' : 'B';
  try { document.cookie = 'dryft_ab=' + v + '; path=/; max-age=31536000; samesite=lax'; } catch (_) {}
  return v;
}
window.__dryftVariant = assignVariant();
(function applyVariant() {
  const cfg = AB_VARIANTS[window.__dryftVariant];
  if (!cfg) return;
  const l1 = document.querySelector('.statement-line1');
  const l2 = document.querySelector('.statement-line2');
  const sub = document.querySelector('.statement-sub');
  if (l1) l1.textContent = cfg.line1;
  if (l2) l2.textContent = cfg.line2;
  if (sub) setSubText(sub, cfg.sub);
})();
// Render the subhead with a sentence-boundary <br class="sub-break">. The break
// is hidden on desktop (one line) and shown on mobile (two lines), so the sub
// never spans wider than the squeezed hero. Built with DOM nodes (no innerHTML).
function setSubText(node, text) {
  const m = text.match(/^(.*?\.)\s+(.*)$/);
  node.textContent = '';
  if (!m) { node.textContent = text; return; }
  node.appendChild(document.createTextNode(m[1] + ' ')); // trailing space keeps the gap when break is hidden
  const br = document.createElement('br');
  br.className = 'sub-break';
  node.appendChild(br);
  node.appendChild(document.createTextNode(m[2]));
}
// One variant-tagged view event per load so per-variant conversion RATE is
// computable in Vercel Analytics (Submit Success / Hero View, both tagged).
track('Hero View');

/* ---------------- traffic source (first-touch) + first-party pageview ----------------
   Classify the first-touch channel from referrer/UTM, remember it for a year,
   and tag both the pageview ping and the eventual signup with it. */
function detectChannel() {
  try {
    var params = new URLSearchParams(location.search);
    var utm = (params.get('utm_source') || '').toLowerCase();
    var ref = document.referrer || '';
    var host = '';
    try { host = ref ? new URL(ref).hostname.replace(/^www\./, '') : ''; } catch (_) { host = ''; }
    if (host && host === location.hostname.replace(/^www\./, '')) return null; // internal nav
    var social = /(instagram|tiktok|twitter|x\.com|t\.co|facebook|fb\.com|linkedin|reddit|youtube|snapchat|pinterest|threads)/;
    var search = /(google|bing|duckduckgo|yahoo|ecosia|baidu|brave|qwant)/;
    var src = utm || host;
    if (!src) return 'Direct';
    if (social.test(src)) return 'Social';
    if (search.test(src)) return 'Organic Search';
    return 'Referral';
  } catch (_) { return 'Direct'; }
}
function firstTouchChannel() {
  try {
    var m = document.cookie.match(/(?:^|;\s*)dryft_ch=([^;]+)/);
    if (m) return decodeURIComponent(m[1]);
  } catch (_) { /* cookies blocked */ }
  var ch = detectChannel() || 'Direct';
  try { document.cookie = 'dryft_ch=' + encodeURIComponent(ch) + '; path=/; max-age=31536000; samesite=lax'; } catch (_) {}
  return ch;
}
window.__dryftChannel = firstTouchChannel();
// First-party pageview ping (same-origin → ad blockers don't block it), for true
// owned visit counts. Skipped on local so dev/preview never inflates the numbers.
if (!IS_LOCAL_HOST) {
  try {
    var pvBody = JSON.stringify({ channel: window.__dryftChannel, variant: window.__dryftVariant || '' });
    if (navigator.sendBeacon) {
      navigator.sendBeacon('/api/pageview', new Blob([pvBody], { type: 'application/json' }));
    } else {
      fetch('/api/pageview', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: pvBody, keepalive: true }).catch(function () {});
    }
  } catch (_) { /* never break the page on analytics */ }
}

/* ---------------- engagement instrumentation ----------------
   Three lightweight, fire-once signals that power the daily dashboard. All go
   through track() to GA4 only (no DB writes). The dashboard reads them back as:
   hero CTA click rate, scroll-depth distribution, and section reach (an in-house
   stand-in for "where people drop off / exit"). */

// CTA clicks that drive to the waitlist, tagged by placement. `hero` is the
// primary hero CTA; nav/sticky let us compare placements later.
document.querySelectorAll('a[href="#waitlist"]').forEach(function (a) {
  var loc = a.classList.contains('statement-cta') ? 'hero'
    : a.classList.contains('nav-cta') ? 'nav'
      : a.classList.contains('sticky-cta') ? 'sticky' : 'other';
  a.addEventListener('click', function () { track('CTA Click', { location: loc }); }, { passive: true });
});

// Scroll-depth milestones, each fired at most once per page load.
(function scrollDepth() {
  var marks = [25, 50, 75, 100];
  var hit = {};
  var ticking = false;
  function check() {
    var height = document.documentElement.scrollHeight - window.innerHeight;
    var pct = height > 0 ? (window.scrollY / height) * 100 : 100;
    marks.forEach(function (m) {
      if (!hit[m] && pct >= m) { hit[m] = true; track('Scroll Depth', { depth: String(m) }); }
    });
    if (hit[100]) window.removeEventListener('scroll', onScroll);
  }
  function onScroll() {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(function () { check(); ticking = false; });
  }
  window.addEventListener('scroll', onScroll, { passive: true });
  check();
})();

// Section reach: fire once when each top-level section first enters view. The
// drop between consecutive sections approximates where attention is lost.
(function sectionViews() {
  var sections = document.querySelectorAll('#main-content > section');
  if (!('IntersectionObserver' in window) || !sections.length) return;
  var obs = new IntersectionObserver(function (entries) {
    entries.forEach(function (e) {
      if (!e.isIntersecting) return;
      var name = e.target.id || (e.target.className || '').split(/\s+/)[0] || 'section';
      track('Section View', { section: name });
      obs.unobserve(e.target);
    });
  }, { threshold: 0.4 });
  sections.forEach(function (s) { obs.observe(s); });
})();

/* ---------------- nav scroll ---------------- */
const nav = document.getElementById('nav');
if (nav) {
  window.addEventListener('scroll', () => {
    nav.classList.toggle('scrolled', window.scrollY > 40);
  }, { passive: true });
}

/* ---------------- mobile menu ---------------- */
const navToggle = document.getElementById('nav-toggle');
const mobileMenu = document.getElementById('mobile-menu');
if (navToggle && mobileMenu) {
  const setMenu = (open) => {
    navToggle.setAttribute('aria-expanded', String(open));
    navToggle.setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
    if (open) {
      mobileMenu.hidden = false;
      requestAnimationFrame(() => mobileMenu.classList.add('open'));
      document.body.classList.add('menu-open');
    } else {
      mobileMenu.classList.remove('open');
      document.body.classList.remove('menu-open');
      setTimeout(() => { if (navToggle.getAttribute('aria-expanded') === 'false') mobileMenu.hidden = true; }, 340);
    }
  };
  navToggle.addEventListener('click', () => setMenu(navToggle.getAttribute('aria-expanded') !== 'true'));
  mobileMenu.querySelectorAll('a').forEach(a => a.addEventListener('click', () => setMenu(false)));
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && navToggle.getAttribute('aria-expanded') === 'true') setMenu(false); });
  const desktopBreakpoint = window.matchMedia('(min-width: 1081px)');
  desktopBreakpoint.addEventListener('change', (e) => { if (e.matches) setMenu(false); });
}

/* ---------------- scroll reveals ---------------- */
const reveals = document.querySelectorAll('.reveal');
const revealObserver = new IntersectionObserver((entries) => {
  entries.forEach((e, i) => {
    if (e.isIntersecting) {
      setTimeout(() => e.target.classList.add('visible'), i * 70);
      revealObserver.unobserve(e.target);
    }
  });
}, { threshold: 0.12, rootMargin: '0px 0px -40px 0px' });
reveals.forEach(r => revealObserver.observe(r));

/* ---------------- sticky mobile CTA ----------------
   Hide the floating "Join Beta" pill while the #waitlist form is on screen, so
   it never sits on top of the form it points to. CSS keeps it mobile-only. */
const stickyCta = document.getElementById('sticky-cta');
const waitlistSection = document.getElementById('waitlist');
if (stickyCta && waitlistSection && 'IntersectionObserver' in window) {
  new IntersectionObserver((entries) => {
    entries.forEach((e) => stickyCta.classList.toggle('hide', e.isIntersecting));
  }, { threshold: 0.15 }).observe(waitlistSection);
}

/* ---------------- team cards: tap-to-reveal on touch ----------------
   On hover-capable devices the experience overlay shows on hover (CSS only).
   On touch devices there's no hover, so tapping a card toggles its overlay;
   opening one closes the others so only a single overlay shows at a time. */
const touchOnly = window.matchMedia('(hover: none)');
const teamCards = document.querySelectorAll('.team-card');
teamCards.forEach((card) => {
  card.addEventListener('click', () => {
    if (!touchOnly.matches) return;
    const willOpen = !card.classList.contains('is-revealed');
    teamCards.forEach((c) => c.classList.remove('is-revealed'));
    if (willOpen) card.classList.add('is-revealed');
  });
});

/* =================================================================
   WAITLIST, anti-abuse posture (front-end only):
     1. Honeypot field (in markup), bots fill all visible inputs
     2. Short dwell time, instant-submit bots get rejected
     3. Per-form throttle, no spam-clicking submit
     4. Per-page-load rate limit (in-memory), protects the API endpoint
        from one tab hammering. Resets on reload, which is fine for the threat we
        actually care about (bots, not determined humans).
     5. Strict phone validation + sanitization

   The endpoints below are same-origin Vercel serverless functions that
   write to Firestore via the Firebase Admin SDK. Server-side validation
   mirrors the client-side sanitizers as defense in depth, the client is
   not the source of truth for what's allowed.
================================================================= */
const WAITLIST_ENDPOINT = '/api/waitlist';
const SURVEY_ENDPOINT   = '/api/survey';
const LOOKUP_ENDPOINT   = '/api/lookup';
const STATS_ENDPOINT    = '/api/stats';

// reCAPTCHA v3 site key, set in the <meta> in index.html. If the placeholder
// is still in place we never call grecaptcha (and the server-side verifier
// also no-ops when its secret isn't set), so the site works either way.
const RECAPTCHA_SITE_KEY = (document.querySelector('meta[name="recaptcha-site-key"]') || {}).content || '';
const RECAPTCHA_ENABLED  = RECAPTCHA_SITE_KEY && RECAPTCHA_SITE_KEY.indexOf('YOUR_') !== 0;

// Resolves to a fresh v3 token, or '' if reCAPTCHA isn't enabled or the
// script hasn't loaded yet. We never block the user on this, if it returns
// '', the server side either accepts (reCAPTCHA disabled) or rejects with
// recaptcha:missing-token (reCAPTCHA enforced), and either is acceptable
// for a transient script-load failure.
function getRecaptchaToken(action) {
  if (!RECAPTCHA_ENABLED || typeof grecaptcha === 'undefined') return Promise.resolve('');
  return new Promise(function (resolve) {
    try {
      grecaptcha.ready(function () {
        grecaptcha.execute(RECAPTCHA_SITE_KEY, { action: action })
          .then(function (t) { resolve(t || ''); })
          .catch(function () { resolve(''); });
      });
    } catch (_) { resolve(''); }
  });
}
const PAGE_LOAD_TS = Date.now();
const MIN_HUMAN_DWELL_MS = 1200;
const MIN_SUBMIT_INTERVAL_MS = 800;
const MAX_SUBMITS_PER_SESSION = 5;
// Phone: Canada / United States, both +1 (North American Numbering Plan). The
// region <select> carries its dial code via data-dial; we combine it with the
// typed national number into E.164 (+1 + 10 NANP digits, area/exchange 2-9).
const NANP_REGEX = /^\+1[2-9]\d{2}[2-9]\d{6}$/;
let submitCount = 0;
let lastSubmitAt = 0;
const submittedPhones = new Set();

// Combine the selected dial code with whatever the user typed into E.164.
// Tolerant of punctuation, spaces, and a leading country code ("(416) 555-0123",
// "1 416 555 0123", "+14165550123" all normalize the same way). Returns '' if
// the digit count doesn't fit the plan.
function toE164(rawInput, dialCode) {
  let digits = String(rawInput || '').replace(/\D/g, '').slice(0, 15);
  if (!digits) return '';
  const dc = String(dialCode || '1');
  if (dc === '1') {
    if (digits.length === 11 && digits[0] === '1') digits = digits.slice(1);
    return digits.length === 10 ? '+1' + digits : '';
  }
  return '+' + dc + digits;
}
function isPlausiblePhone(e164) {
  return NANP_REGEX.test(String(e164 || ''));
}
// Read the region <select> + tel <input> from a form and return the normalized
// E.164 number, the chosen region code, and the input element (for focus/shake).
function readPhone(form) {
  const input = form.querySelector('input[type="tel"]');
  const select = form.querySelector('select[name="region"]');
  const opt = select && select.options[select.selectedIndex];
  const dial = (opt && opt.getAttribute('data-dial')) || '1';
  const region = (select && select.value) || 'CA';
  return { e164: toE164(input ? input.value : '', dial), region: region, input: input };
}
function shakeForm(wrap, input) {
  wrap.style.borderColor = 'var(--damage)';
  wrap.style.boxShadow = '0 0 0 4px rgba(196,77,60,0.15)';
  if (input) input.focus();
  setTimeout(() => { wrap.style.borderColor = ''; wrap.style.boxShadow = ''; }, 1600);
}
function flashButton(btn, msg, ms = 2000) {
  if (!btn) return;
  const original = btn.dataset.originalLabel || btn.textContent;
  btn.dataset.originalLabel = original;
  btn.textContent = msg;
  btn.disabled = true;
  setTimeout(() => { btn.textContent = original; btn.disabled = false; }, ms);
}
// Map a submission source to its form + success-banner element ids.
const FORM_IDS = {
  hero:     { form: 'hero-form',     success: 'hero-success' },
  final:    { form: 'final-form',    success: 'final-success' },
  referral: { form: 'referral-form', success: 'referral-success' },
};
function showSuccess(source) {
  const ids = FORM_IDS[source] || FORM_IDS.final;
  const f = document.getElementById(ids.form);
  const s = document.getElementById(ids.success);
  if (f) f.style.display = 'none';
  if (s) s.style.display = 'block';
}

// Fill the survey modal's referral banner from the /api/waitlist response.
// Shows the user's shareable code + (if known) their live waitlist position.
// Tolerant of a missing position, the count query is best-effort server-side.
function populateReferralBanner(data) {
  if (!data || !data.referralCode) return;
  const banner = document.getElementById('survey-referral');
  const codeEl = document.getElementById('survey-code');
  const posEl = document.getElementById('survey-position');
  if (codeEl) codeEl.textContent = data.referralCode;
  if (posEl) {
    if (typeof data.position === 'number' && data.position > 0) {
      posEl.textContent = "You're #" + data.position.toLocaleString() + ' on the waitlist';
      posEl.hidden = false;
    } else {
      posEl.hidden = true;
    }
  }
  if (banner) banner.hidden = false;
}

// Wire the "Copy" button once. Copies the currently-shown code to the clipboard
// with a brief "Copied" confirmation. Guarded so it no-ops where the button is
// absent (e.g. the legal pages don't load the survey modal).
(function wireReferralCopy() {
  const btn = document.getElementById('survey-copy');
  const codeEl = document.getElementById('survey-code');
  if (!btn || !codeEl) return;
  btn.addEventListener('click', function () {
    const code = (codeEl.textContent || '').trim();
    if (!code || code === '…') return;
    const done = function () {
      const orig = btn.dataset.label || btn.textContent;
      btn.dataset.label = orig;
      btn.textContent = 'Copied';
      setTimeout(function () { btn.textContent = btn.dataset.label || 'Copy'; }, 1500);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(code).then(done).catch(done);
    } else {
      done();
    }
  });
})();

async function handleWaitlistSubmit(form, source) {
  const phoneInput = form.querySelector('input[type="tel"]');
  const honeypot = form.querySelector('input[name="company"]');
  const btn = form.querySelector('button[type="submit"]');
  if (!phoneInput || !btn) return;

  // Honeypot, any value means bot. Silent reject.
  if (honeypot && honeypot.value !== '') { form.reset(); return; }

  // Dwell, instant submits are bots
  const now = Date.now();
  if (now - PAGE_LOAD_TS < MIN_HUMAN_DWELL_MS) { shakeForm(form, phoneInput); return; }

  // Per-form throttle (prevents accidental double-submits, doesn't block retries)
  if (now - lastSubmitAt < MIN_SUBMIT_INTERVAL_MS) return;

  // Rate limit per page-load. Visible feedback when hit.
  if (submitCount >= MAX_SUBMITS_PER_SESSION) {
    flashButton(btn, 'Too many tries, refresh', 2500);
    return;
  }

  // Genuine human attempt (passed honeypot + dwell + throttle). Fired before
  // validation so we also capture friction from invalid/incomplete numbers.
  track('Waitlist Submit Attempt', { source: source });

  const { e164: phone, region } = readPhone(form);
  if (!isPlausiblePhone(phone)) { shakeForm(form, phoneInput); return; }

  // Duplicate in this page-load, show success without re-posting (no enumeration leak).
  if (submittedPhones.has(phone)) { showSuccess(source); return; }

  // All checks passed, commit
  lastSubmitAt = now;
  submitCount++;
  submittedPhones.add(phone);

  btn.textContent = 'Saving…';
  btn.disabled = true;
  phoneInput.disabled = true;

  // Show success + open the survey IMMEDIATELY. The POST is fired below as
  // fire-and-forget, we don't make the user wait on network latency.
  showSuccess(source);
  track('Waitlist Submit Success', { source: source });
  openSurvey(phone, source);
  bumpJoinCount(); // optimistic +1, the signup is committed; no extra /api pull

  // Optional referral code (only the /referral form carries one). Server
  // sanitizes + validates; we just pass through a trimmed value.
  const codeInput = form.querySelector('input[name="referredByCode"]');
  const referredByCode = codeInput ? String(codeInput.value || '').trim().slice(0, 32) : '';

  // Same-origin POST to our Vercel function, we CAN read the response, so we
  // parse it to surface the user's referral code + position in the survey
  // banner. We still don't block the UI on it (the survey is already open);
  // errors surface in the console and the server write is idempotent.
  getRecaptchaToken('waitlist').then(function (recaptchaToken) {
    const payload = { phone: phone, region: region, source: source, variant: window.__dryftVariant || 'A', channel: window.__dryftChannel || 'Direct', dwell_ms: now - PAGE_LOAD_TS, recaptchaToken: recaptchaToken };
    if (referredByCode) payload.referredByCode = referredByCode;
    return fetch(WAITLIST_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      keepalive: true,  // lets the request finish even if the tab navigates
    });
  }).then(function (resp) {
    return resp && resp.ok ? resp.json() : null;
  }).then(function (data) {
    if (data && data.ok) populateReferralBanner(data);
  }).catch(function (err) { console.error('[dryft waitlist] save failed:', err); });
}

const FORM_SOURCES = { 'hero-form': 'hero', 'final-form': 'final', 'referral-form': 'referral' };
Object.keys(FORM_SOURCES).forEach((id) => {
  const form = document.getElementById(id);
  if (!form) return;
  const source = FORM_SOURCES[id];
  form.setAttribute('novalidate', '');
  // Top-of-funnel signal: the visitor engaged the phone field. Fire once per
  // form so a single signup isn't counted as many focus events.
  const telInput = form.querySelector('input[type="tel"]');
  if (telInput) {
    let focusTracked = false;
    telInput.addEventListener('focus', () => {
      if (focusTracked) return;
      focusTracked = true;
      track('Waitlist Field Focus', { source: source });
    });
  }
  form.addEventListener('submit', (e) => { e.preventDefault(); handleWaitlistSubmit(form, source); });
});

/* =================================================================
   SURVEY MODAL, fired after a successful waitlist submission.
   Phone is already captured; this is purely optional signal collection.
   Single-select chips (stage) + 6 Likert scales (0-5).
================================================================= */
const surveyModal = document.getElementById('survey-modal');
const surveyForm = document.getElementById('survey-form');
const surveySuccess = document.getElementById('survey-success');
let surveyPhone = '';
let surveySource = '';
let surveyLastFocus = null;

// --- Progressive autosave state -------------------------------------------
// Every selection is saved to Firebase as it happens (debounced). The server
// keys the doc by the user's phone, so changing an answer overwrites it in one
// doc and reopening the survey reuses that same doc. This captures partial data
// even if the user abandons before "Send answers".
let surveyAutosaveSnapshot = '';  // last payload we sent (dedupe identical saves)
let surveyAutosaveTimer = null;   // debounce handle
let surveyCompleted = false;      // true once the final submit succeeds
const SURVEY_AUTOSAVE_DEBOUNCE_MS = 700;
// Assigned by the survey IIFE once the autosave helpers exist; called from the
// module-scope select/close/open handlers. No-ops until then.
let triggerSurveyAutosave = function () {};
let flushSurveyAutosave = function () {};
let restoreSurveyAnswers = function () {};

function openSurvey(phone, source) {
  if (!surveyModal) return;
  surveyPhone = phone;
  surveySource = source;
  // Clean autosave state. The doc is keyed server-side by phone, so reopening
  // the survey for the same person continues their existing doc.
  surveyAutosaveSnapshot = '';
  surveyCompleted = false;
  clearTimeout(surveyAutosaveTimer);
  // Reset selections + form state in case the modal was opened earlier in this session
  resetSurvey();
  // Hide the referral banner until the waitlist response populates it (avoids
  // flashing a stale code if the modal was opened earlier this session).
  const refBanner = document.getElementById('survey-referral');
  if (refBanner) refBanner.hidden = true;
  // If this same phone answered before on this browser, pre-fill their prior
  // selections so they can see and continue where they left off.
  restoreSurveyAnswers(phone);
  surveyLastFocus = document.activeElement;
  surveyModal.hidden = false;
  // Force reflow before adding .open so the CSS transition fires
  void surveyModal.offsetWidth;
  surveyModal.classList.add('open');
  document.body.classList.add('survey-open');
  // Always open at the top question, both the form (internal scroll on mobile)
  // and the card (internal scroll on desktop) are rewound to 0.
  if (surveyForm) surveyForm.scrollTop = 0;
  const card = surveyModal.querySelector('.survey-card');
  if (card) card.scrollTop = 0;
  // Focus the close button so ESC + Tab work predictably
  setTimeout(() => surveyModal.querySelector('.survey-close')?.focus(), 50);
}

function closeSurvey() {
  if (!surveyModal) return;
  // Capture the latest answers if the user bails out without submitting.
  // (No-op if they already completed, guarded inside the autosave helper.)
  flushSurveyAutosave();
  surveyModal.classList.remove('open');
  document.body.classList.remove('survey-open');
  setTimeout(() => {
    surveyModal.hidden = true;
    if (surveyLastFocus && typeof surveyLastFocus.focus === 'function') {
      try { surveyLastFocus.focus(); } catch (_) {}
    }
  }, 320);
}

function resetSurvey() {
  if (!surveyForm) return;
  surveyForm.style.display = '';
  if (surveySuccess) surveySuccess.hidden = true;
  surveyForm.querySelectorAll('.survey-chip.selected, .survey-num.selected').forEach(b => {
    b.classList.remove('selected');
    b.setAttribute('aria-checked', 'false');
  });
  surveyForm.querySelectorAll('input[type="hidden"]').forEach(h => { h.value = ''; });
  surveyForm.querySelectorAll('.survey-q.unanswered').forEach(q => q.classList.remove('unanswered'));
  document.getElementById('survey-missing-notice')?.remove();
  document.getElementById('survey-sending-notice')?.remove();
  surveyForm.querySelector('.survey-actions')?.classList.remove('has-notice');
  const sub = surveyForm.querySelector('.survey-submit');
  if (sub) { sub.disabled = false; sub.textContent = 'Send answers'; }
}

function bindSelectGroup(container, hiddenName) {
  const buttons = container.querySelectorAll('button');
  const hidden = surveyForm.querySelector(`input[name="${hiddenName}"]`);
  const qBlock = container.closest('.survey-q');
  buttons.forEach(btn => {
    btn.addEventListener('click', () => {
      buttons.forEach(b => {
        b.classList.remove('selected');
        b.setAttribute('aria-checked', 'false');
      });
      btn.classList.add('selected');
      btn.setAttribute('aria-checked', 'true');
      if (hidden) hidden.value = btn.dataset.value;
      // Persist this choice to Firebase (debounced). Re-selecting overwrites it.
      triggerSurveyAutosave();
      // Clear missing-state for this question
      if (qBlock) qBlock.classList.remove('unanswered');
      // Auto-dismiss the global "missing" notice if every question now has a value.
      // Inlined here (rather than calling a helper) because bindSelectGroup is at
      // module scope and the validation helpers live inside the survey IIFE block.
      const stillMissing = [...surveyForm.querySelectorAll('input[type="hidden"]')]
        .some(i => !i.value);
      if (!stillMissing) {
        document.getElementById('survey-missing-notice')?.remove();
        // Drop the column-layout flag on .survey-actions if nothing's using it
        const actions = surveyForm.querySelector('.survey-actions');
        if (actions && !actions.querySelector('.survey-sending-notice, .survey-missing-notice')) {
          actions.classList.remove('has-notice');
        }
      }
    });
  });
}

if (surveyModal && surveyForm) {
  // Chip groups (currently only "stage")
  surveyForm.querySelectorAll('[data-chip-group]').forEach(group => {
    bindSelectGroup(group, group.dataset.chipGroup);
  });
  // Scale (Likert) groups
  surveyForm.querySelectorAll('[data-scale]').forEach(group => {
    bindSelectGroup(group, group.dataset.scale);
  });

  // All "data-survey-close" elements close the modal (backdrop, X, Skip, Done)
  surveyModal.querySelectorAll('[data-survey-close]').forEach(el => {
    el.addEventListener('click', closeSurvey);
  });

  // ESC closes
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && surveyModal.classList.contains('open')) closeSurvey();
  });

  // ----- Front-end sanitization helpers -----
  // Even though the values are set by us via button clicks on data-value attributes,
  // a curious user could modify the hidden inputs via devtools. These allowlists
  // make sure nothing other than the expected values reaches the server.
  // (The server re-validates against the same allowlists, this is defense in depth.)
  const VALID_CAREER_STAGES = new Set([
    'Student',
    'Early-career (0-3yrs)',
    'Mid-career (4-10yrs)',
    'Experienced-career (10+ yrs)',
    'Self-employed',
    'Business owner',
    'Not working',
    'Retired',
    'Prefer not to say',
  ]);
  const VALID_LIFE_STAGES = new Set([
    'Living with family',
    'Living alone',
    'Living with partner',
    'Living with partner + children',
    'Single parent',
    'Caregiving for family member(s)',
    'Empty nester',
    'Prefer not to say',
  ]);
  // Likert scale: empty string (unanswered) or "1"–"5"
  const VALID_SCALE = new Set(['', '1', '2', '3', '4', '5']);
  // Yes/No question (q8): empty string (unanswered) or "Yes"/"No"
  const VALID_YESNO = new Set(['', 'Yes', 'No']);
  // Survey-level throttle to mirror the waitlist anti-abuse posture
  let surveySubmitCount = 0;
  let surveyLastSubmitAt = 0;
  const MAX_SURVEY_SUBMITS = 3;

  // In-flight guard: when true, prompt the user before they close/refresh the tab.
  // Set true the moment the POST starts; cleared when the fetch settles (success or fail).
  let isSurveySubmitting = false;
  window.addEventListener('beforeunload', (e) => {
    if (!isSurveySubmitting) return;
    // Modern browsers ignore custom strings for security; just trigger the prompt.
    // Setting returnValue (legacy) + preventDefault covers all browser variants.
    e.preventDefault();
    e.returnValue = 'Your survey answers are still saving, please wait a moment before closing.';
    return e.returnValue;
  });

  function sanitizeCareerStage(v) {
    const s = String(v == null ? '' : v).trim().slice(0, 64);
    return VALID_CAREER_STAGES.has(s) ? s : '';
  }
  function sanitizeLifeStage(v) {
    const s = String(v == null ? '' : v).trim().slice(0, 64);
    return VALID_LIFE_STAGES.has(s) ? s : '';
  }
  function sanitizeScale(v) {
    // Reject anything that isn't exactly "" or "1".."5"
    const s = String(v == null ? '' : v).trim();
    return VALID_SCALE.has(s) ? s : '';
  }
  function sanitizeYesNo(v) {
    const s = String(v == null ? '' : v).trim().slice(0, 8);
    return VALID_YESNO.has(s) ? s : '';
  }
  // Open-ended free-text answer (q9). Strips control chars (keeps \n, \t),
  // collapses long runs of whitespace, defuses spreadsheet formula injection
  // (=, +, -, @, tab at start), and caps length so a single user can't bloat
  // the sheet row. Empty strings are fine, q9 is optional.
  // The Apps Script writeRow ALSO applies a formula-injection guard, so this
  // is defense in depth, even if that guard is ever removed, the textarea
  // value still arrives at the sheet as plain text.
  function sanitizeText(v) {
    if (v == null) return '';
    let s = String(v);
    // eslint-disable-next-line no-control-regex
    s = s.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
    s = s.replace(/[ \t]{3,}/g, '  '); // collapse runaway spaces
    s = s.replace(/\n{4,}/g, '\n\n\n'); // cap blank-line runs
    s = s.trim().slice(0, 2000);
    // Sheets/CSV formula injection: a leading =, +, -, @, or tab makes the
    // cell evaluate as a formula. Prefix a single quote (Sheets' text-literal
    // marker, rendered invisibly) to neutralize.
    if (s && /^[=+\-@\t\r]/.test(s)) s = "'" + s;
    return s;
  }

  // ----- Progressive autosave -----
  // Snapshot the survey's CURRENT state (answered + blank fields). We send the
  // full snapshot every time and the server merges it, so the stored doc always
  // mirrors what's on screen, changing any answer overwrites it.
  function currentSurveyPayload(complete) {
    const data = new FormData(surveyForm);
    const payload = {
      phone: String(surveyPhone || ''),
      source: String(surveySource || '').replace(/[^a-z]/gi, '').slice(0, 16),
      careerStage: sanitizeCareerStage(data.get('careerStage')),
      lifeStage: sanitizeLifeStage(data.get('lifeStage')),
      q8: sanitizeYesNo(data.get('q8')),
      q9: sanitizeText(data.get('q9')),
      complete: !!complete,
    };
    ['q1', 'q2', 'q3', 'q4', 'q5', 'q6', 'q7']
      .forEach((k) => { payload[k] = sanitizeScale(data.get(k)); });
    return payload;
  }

  // Fire a partial save now. `useBeacon` uses navigator.sendBeacon so the write
  // survives the page being torn down (tab close / navigation). Dedupes against
  // the last payload so we don't spam identical writes.
  function autosaveNow(useBeacon) {
    if (surveyCompleted) return;          // final submit already wrote the doc
    if (!surveyPhone) return;             // phone is the server-side doc key
    saveSurveyDraft();                    // keep the local (this-browser) copy fresh
    const payload = currentSurveyPayload(false);
    payload.partial = true;               // relaxed validation + autosave bucket
    const snap = JSON.stringify(payload);
    if (snap === surveyAutosaveSnapshot) return; // nothing changed since last save
    surveyAutosaveSnapshot = snap;
    if (useBeacon && navigator.sendBeacon) {
      try {
        navigator.sendBeacon(SURVEY_ENDPOINT, new Blob([snap], { type: 'application/json' }));
        return;
      } catch (_) { /* fall through to fetch */ }
    }
    // Fire-and-forget; autosave failures are non-fatal (final submit is the
    // authoritative write, and the next change will retry).
    fetch(SURVEY_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: snap,
      keepalive: true,
    }).catch(() => {});
  }

  // Expose the debounced trigger + an immediate flush to the module scope so the
  // select handlers (bindSelectGroup) and closeSurvey can drive autosave.
  triggerSurveyAutosave = function () {
    clearTimeout(surveyAutosaveTimer);
    surveyAutosaveTimer = setTimeout(() => autosaveNow(false), SURVEY_AUTOSAVE_DEBOUNCE_MS);
  };
  flushSurveyAutosave = function () {
    clearTimeout(surveyAutosaveTimer);
    autosaveNow(false);
  };

  // ----- Local draft (this browser) -----
  // We can't securely fetch a person's prior answers from the server (there's
  // no login/phone verification, so returning answers by number would leak them
  // to anyone who types that number). Instead we keep a per-phone draft in this
  // browser's localStorage purely to PRE-FILL the form when the same number
  // returns here. Accumulating answers into the one server record still works
  // cross-device, this is only the "show what you picked before" convenience.
  const SURVEY_DRAFT_PREFIX = 'dryft.survey.';
  const SURVEY_DRAFT_FIELDS = [
    'careerStage', 'lifeStage',
    'q1', 'q2', 'q3', 'q4', 'q5', 'q6', 'q7', 'q8', 'q9',
  ];
  function draftKey(phone) {
    return SURVEY_DRAFT_PREFIX + String(phone || '').trim().toLowerCase();
  }
  function saveSurveyDraft() {
    if (!surveyPhone) return;
    try {
      const data = new FormData(surveyForm);
      const answers = {};
      SURVEY_DRAFT_FIELDS.forEach((k) => {
        const v = data.get(k);
        if (v != null && String(v) !== '') answers[k] = String(v);
      });
      localStorage.setItem(draftKey(surveyPhone), JSON.stringify(answers));
    } catch (_) { /* storage unavailable/full, non-fatal */ }
  }
  restoreSurveyAnswers = function (phone) {
    let answers;
    try {
      const raw = localStorage.getItem(draftKey(phone));
      if (!raw) return;
      answers = JSON.parse(raw);
    } catch (_) { return; }
    if (!answers || typeof answers !== 'object') return;
    Object.keys(answers).forEach((name) => {
      const value = String(answers[name]);
      const hidden = surveyForm.querySelector(`input[type="hidden"][name="${name}"]`);
      if (hidden) {
        hidden.value = value;
        const group = surveyForm.querySelector(`[data-scale="${name}"], [data-chip-group="${name}"]`);
        if (group) {
          group.querySelectorAll('button').forEach((b) => {
            const on = b.dataset.value === value;
            b.classList.toggle('selected', on);
            b.setAttribute('aria-checked', on ? 'true' : 'false');
          });
        }
        const block = hidden.closest('.survey-q');
        if (block) block.classList.remove('unanswered');
      } else {
        const ta = surveyForm.querySelector(`textarea[name="${name}"]`);
        if (ta) ta.value = value;
      }
    });
  };

  // Open-ended textarea (q9): debounce while typing, flush on blur.
  const q9Field = surveyForm.querySelector('textarea[name="q9"]');
  if (q9Field) {
    q9Field.addEventListener('input', () => triggerSurveyAutosave());
    q9Field.addEventListener('blur', () => flushSurveyAutosave());
  }

  // Last-ditch capture if the user leaves with the survey open: beacon the
  // current state so their final choices aren't lost.
  const beaconIfOpen = () => {
    if (surveyModal.classList.contains('open')) autosaveNow(true);
  };
  window.addEventListener('pagehide', beaconIfOpen);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') beaconIfOpen();
  });

  // Derive the question list from the form itself, one hidden input per question.
  // This auto-adapts if questions are added or removed from the HTML.
  function getQuestionInputs() {
    return [...surveyForm.querySelectorAll('input[type="hidden"]')];
  }
  function getMissingQuestions() {
    return getQuestionInputs()
      .filter(input => !input.value)
      .map(input => input.name);
  }
  function showMissingNotice() {
    let n = document.getElementById('survey-missing-notice');
    const actions = surveyForm.querySelector('.survey-actions');
    if (!n) {
      n = document.createElement('div');
      n.id = 'survey-missing-notice';
      n.className = 'survey-missing-notice';
      n.setAttribute('role', 'alert');
      // Same pattern as the sending-notice: live INSIDE the sticky actions row so
      // mobile users always see it regardless of where they scrolled.
      if (actions) {
        actions.classList.add('has-notice');
        actions.insertBefore(n, actions.firstChild);
      }
    }
    n.textContent = 'Please answer all questions.';
  }

  // Submit, posts survey data to the same Apps Script endpoint with kind=survey
  surveyForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const submitBtn = surveyForm.querySelector('.survey-submit');
    if (!submitBtn) return;

    // Completeness gate, every question must have an answer before we POST.
    // We mark each unanswered question, scroll to the first one, and show a notice.
    const missing = getMissingQuestions();
    if (missing.length > 0) {
      surveyForm.querySelectorAll('.survey-q').forEach(q => {
        q.classList.toggle('unanswered', missing.includes(q.dataset.q));
      });
      showMissingNotice();
      const firstBlock = surveyForm.querySelector(`.survey-q[data-q="${missing[0]}"]`);
      if (firstBlock) firstBlock.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }

    // Anti-abuse: throttle submits per page-load (3 max). Visible feedback on hit.
    const nowTs = Date.now();
    if (nowTs - surveyLastSubmitAt < MIN_SUBMIT_INTERVAL_MS) return;
    if (surveySubmitCount >= MAX_SURVEY_SUBMITS) {
      submitBtn.textContent = 'Too many tries';
      submitBtn.disabled = true;
      return;
    }
    surveyLastSubmitAt = nowTs;
    surveySubmitCount++;

    // Cancel any pending debounced autosave, this complete submit supersedes it.
    clearTimeout(surveyAutosaveTimer);

    submitBtn.disabled = true;
    submitBtn.textContent = 'Sending…';
    // Mark in-flight + show the inline "don't close this tab" notice
    isSurveySubmitting = true;
    showSurveySendingNotice(true);

    // Build the JSON payload (same snapshot the autosave uses), flagged
    // complete:true so it upserts the SAME responseId doc and marks it finished.
    // The server re-sanitizes every field; we scrub here for a clean wire format.
    const payload = currentSurveyPayload(true);

    // Completing the survey lifts the responder into the "skip the line" tier,
    // so the server returns their refreshed waitlist position. We surface it in
    // the success screen below. Stays null on any hiccup → line simply hidden.
    let surveyPosition = null;

    try {
      // Attach a fresh reCAPTCHA token (or '' if disabled). Token must be
      // generated AT submit time, v3 tokens expire after ~2 minutes.
      payload.recaptchaToken = await getRecaptchaToken('survey');

      // Same-origin POST → we can await the real response (no opaque no-cors).
      // If the server returns non-2xx we still show success, UX-wise, the
      // user shouldn't be punished for a server hiccup, and we'll see the
      // failure in Vercel logs to investigate.
      const resp = await fetch(SURVEY_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        keepalive: true,
      });
      if (!resp.ok) {
        console.warn('[dryft survey] non-OK response:', resp.status);
      } else {
        surveyAutosaveSnapshot = JSON.stringify(payload);
        // Best-effort: pull the updated waitlist position from the response.
        try {
          const data = await resp.json();
          if (data && typeof data.position === 'number' && data.position > 0) {
            surveyPosition = data.position;
          }
        } catch (_) { /* body unreadable, position stays null */ }
      }
    } catch (err) {
      console.error('[dryft survey] save failed:', err);
    } finally {
      // Clear the guard whether the POST succeeded or failed, request has at
      // least left the browser by this point.
      isSurveySubmitting = false;
      showSurveySendingNotice(false);
    }

    // Persist the final answers to the local draft, then mark completed so the
    // close/beacon handlers don't overwrite the finished doc with a partial.
    saveSurveyDraft();
    surveyCompleted = true;
    track('Survey Complete', { source: surveySource || '' });

    // Always show success, fire-and-forget per the no-cors fetch above
    surveyForm.style.display = 'none';
    // Completing the survey changes the responder's rank, so refresh the
    // position line already shown in the referral banner above (rather than
    // adding a second readout). No-op if the banner/position isn't on screen.
    if (surveyPosition !== null) {
      const posEl = document.getElementById('survey-position');
      if (posEl) {
        posEl.textContent = "You're #" + surveyPosition.toLocaleString() + ' on the waitlist';
        posEl.hidden = false;
      }
    }
    if (surveySuccess) surveySuccess.hidden = false;
  });

  // Toggle the inline "don't close this tab" notice. We insert the notice INSIDE
  // the sticky .survey-actions bar (above the button) so it stays visible on mobile
  // where the actions row floats over the scrolling form content. Adding `.has-notice`
  // switches the actions row to flex-column so the notice sits on its own line.
  function showSurveySendingNotice(on) {
    let notice = document.getElementById('survey-sending-notice');
    const actions = surveyForm.querySelector('.survey-actions');
    if (on) {
      if (notice) return;
      notice = document.createElement('div');
      notice.id = 'survey-sending-notice';
      notice.className = 'survey-sending-notice';
      notice.setAttribute('role', 'status');
      notice.setAttribute('aria-live', 'polite');
      notice.innerHTML = '<span class="survey-sending-dot" aria-hidden="true"></span><span>Saving your answers, please don’t close this tab.</span>';
      if (actions) {
        actions.classList.add('has-notice');
        actions.insertBefore(notice, actions.firstChild);
      }
    } else if (notice) {
      notice.remove();
      // Only drop the column layout if no other notice is using the slot
      if (actions && !actions.querySelector('.survey-sending-notice, .survey-missing-notice')) {
        actions.classList.remove('has-notice');
      }
    }
  }
}

/* =================================================================
   HERO PHONE, NOTIFICATIONS (lock screen cascade)
================================================================= */
// Goal: survive the next 4 months at university (make the money last the whole term).
// Same predict → nudge → recover → adapt arc as the live graph, just on the phone.
const NOTIFICATIONS = [
  { app: 'Dryft', time: 'now', title: 'Takeout again tonight?', body: "That's your 3rd this week, $38 over your food plan." },
  { app: 'Dryft', time: '9:12', title: 'Disney+ renews tomorrow', body: '$14.99 on Friday, easy to forget. Keep it?' },
  { app: 'Dryft', time: 'Mon', title: 'Nice, you skipped it', body: "That's $60 closer to your trip this week." },
  { app: 'Dryft', time: 'Sun', title: "You're on track for rent", body: "Nothing to log, I'm watching it for you." },
];

function makeNotifNode({ app, time, title, body }) {
  const node = document.createElement('div');
  node.className = 'notif';
  node.innerHTML = `
    <div class="notif-head">
      <span class="notif-app">
        <span class="notif-app-icon">
          <svg viewBox="30 32 196 196" fill="currentColor"><path d="M126 38 L126 110 L64 174 Z"/><path d="M126 116 L126 176 L74 176 Z"/><path d="M140 70 L140 176 L206 176 Z"/><path d="M44 188 L212 188 L180 212 Q128 222 76 212 Z"/></svg>
        </span>${app}
      </span>
      <span class="notif-time">${time}</span>
    </div>
    <p class="notif-title">${title}</p>
    <p class="notif-body">${body}</p>
  `;
  return node;
}

async function runNotificationLoop(stack) {
  if (reduceMotion) {
    NOTIFICATIONS.slice(0, 3).forEach((n, i) => {
      const node = makeNotifNode(n);
      node.classList.add('in');
      if (i === 0) node.classList.add('up-2');
      if (i === 1) node.classList.add('up-1');
      stack.appendChild(node);
    });
    return;
  }
  while (true) {
    stack.innerHTML = '';
    const visible = [];
    for (let i = 0; i < NOTIFICATIONS.length; i++) {
      const node = makeNotifNode(NOTIFICATIONS[i]);
      stack.appendChild(node);
      visible.push(node);
      requestAnimationFrame(() => requestAnimationFrame(() => node.classList.add('in')));
      for (let k = 0; k < visible.length - 1; k++) {
        const n = visible[visible.length - 2 - k];
        if (!n) break;
        n.classList.remove('in', 'up-1', 'up-2', 'up-3');
        if (k === 0) n.classList.add('up-1');
        else if (k === 1) n.classList.add('up-2');
        else n.classList.add('up-3');
      }
      while (visible.length > 4) { const old = visible.shift(); setTimeout(() => old.remove(), 600); }
      await wait(3500);
    }
    await wait(2200);
    visible.forEach(n => n.classList.add('up-3'));
    await wait(700);
  }
}

/* =================================================================
   HERO PHONE, CHAT (looping conversation)
================================================================= */
// Two versions of the SAME conversation; the chat loop alternates between them.
// First loop: ask a question, and check how your budget changed.
const CHAT_SEQUENCE = [
  { typed: 'can I grab takeout tonight?', typeSpeed: 55, thinkLabel: 'Checking your week', thinkDuration: 1100, response: 'You\'ve got $24 left for food. Go for it.', streamSpeed: 18, afterPause: 1800 },
  { typed: 'what changed in my budget this week?', typeSpeed: 60, thinkLabel: 'Pulling it up', thinkDuration: 1300, response: 'Groceries came in low, so you\'ve got $40 extra.', streamSpeed: 20, showImpact: true, followup: 'Want me to roll it toward your trip?', followupSpeed: 16, afterPause: 2400 },
];
// Second loop: update your goal or your plan, and Dryft adjusts.
const CHAT_SEQUENCE_TO = [
  { typed: 'I want to save for a trip in August', typeSpeed: 55, thinkLabel: 'Building your plan', thinkDuration: 1100, response: 'Done. $35 a week gets you there.', streamSpeed: 18, afterPause: 1800 },
  { typed: 'bump my coffee budget up a little', typeSpeed: 60, thinkLabel: 'Adjusting your plan', thinkDuration: 1300, response: 'Got it, $20 more a month for coffee.', streamSpeed: 20, showImpact: true, followup: 'Your trip date moves to September 2nd.', followupSpeed: 16, afterPause: 2400 },
];
const CHAT_LOOPS = [CHAT_SEQUENCE, CHAT_SEQUENCE_TO];

async function typeInto(node, text, speed) {
  node.textContent = '';
  for (let i = 0; i < text.length; i++) {
    node.textContent += text[i];
    const jitter = (text[i] === ' ') ? speed * 0.4 : speed * (0.7 + Math.random() * 0.6);
    await wait(jitter);
  }
}
async function streamBubble(feed, text, speed) {
  const bubble = document.createElement('div');
  bubble.className = 'bubble dryft';
  const stream = document.createElement('span');
  stream.className = 'stream';
  bubble.appendChild(stream);
  feed.appendChild(bubble);
  requestAnimationFrame(() => bubble.classList.add('show'));
  for (let i = 0; i < text.length; i++) {
    const span = document.createElement('span');
    span.className = 'stream-char';
    span.textContent = text[i];
    stream.appendChild(span);
    const jitter = speed * (0.5 + Math.random() * 1.1);
    await wait(jitter);
  }
  return bubble;
}
function addUserBubble(feed, text) {
  const bubble = document.createElement('div');
  bubble.className = 'bubble user';
  bubble.textContent = text;
  feed.appendChild(bubble);
  requestAnimationFrame(() => bubble.classList.add('show'));
  return bubble;
}
function addThinking(feed, label) {
  const node = document.createElement('div');
  node.className = 'thinking';
  node.innerHTML = `<span class="thinking-label">${label}</span><span class="thinking-dots"><span></span><span></span><span></span></span>`;
  feed.appendChild(node);
  requestAnimationFrame(() => node.classList.add('show'));
  return node;
}
function addImpactCard(feed) {
  const card = document.createElement('div');
  card.className = 'impact-card';
  card.innerHTML = `
    <div class="impact-head"><strong>Plan impact</strong><em>vs target</em></div>
    <div class="impact-bars">
      <div class="impact-bar"><div class="impact-bar-fill" data-h="42"></div></div>
      <div class="impact-bar"><div class="impact-bar-fill red" data-h="92"></div></div>
      <div class="impact-bar"><div class="impact-bar-fill" data-h="54"></div></div>
      <div class="impact-bar"><div class="impact-bar-fill" data-h="68"></div></div>
      <div class="impact-bar"><div class="impact-bar-fill" data-h="48"></div></div>
    </div>
    <div class="impact-labels"><span>Rent</span><span>Food</span><span>Subs</span><span>Gas</span><span>Save</span></div>
    <div class="impact-action">Move $64 to Bills</div>
  `;
  feed.appendChild(card);
  requestAnimationFrame(() => card.classList.add('show'));
  setTimeout(() => {
    card.querySelectorAll('.impact-bar-fill').forEach((bar, i) => {
      setTimeout(() => { bar.style.height = `${bar.dataset.h}%`; }, i * 110);
    });
  }, 250);
  return card;
}
async function fadeOutFeed(feed) {
  const items = [...feed.children];
  items.forEach((n, i) => {
    setTimeout(() => {
      n.style.transition = 'opacity 0.3s ease, transform 0.3s ease';
      n.style.opacity = '0';
      n.style.transform = 'translateY(-6px)';
    }, i * 60);
  });
  await wait(items.length * 60 + 320);
  feed.innerHTML = '';
}

async function runChatLoop(phone) {
  const feed = phone.querySelector('[data-chat-feed]');
  const inputText = phone.querySelector('[data-chat-input]');
  const cursor = phone.querySelector('.chat-cursor');
  const sendBtn = phone.querySelector('[data-chat-send]');
  if (!feed || !inputText || !cursor || !sendBtn) return;
  if (reduceMotion) {
    addUserBubble(feed, CHAT_SEQUENCE[1].typed);
    const b = document.createElement('div');
    b.className = 'bubble dryft show';
    b.textContent = CHAT_SEQUENCE[1].response;
    feed.appendChild(b);
    const card = addImpactCard(feed);
    setTimeout(() => { card.querySelectorAll('.impact-bar-fill').forEach(bar => bar.style.height = `${bar.dataset.h}%`); }, 200);
    return;
  }
  await wait(900);
  let loopIdx = 0;
  while (true) {
    const sequence = CHAT_LOOPS[loopIdx % CHAT_LOOPS.length];
    for (const step of sequence) {
      cursor.classList.add('active');
      await typeInto(inputText, step.typed, step.typeSpeed);
      await wait(280);
      sendBtn.classList.add('active');
      await wait(140);
      const sentText = inputText.textContent;
      inputText.textContent = '';
      sendBtn.classList.remove('active');
      cursor.classList.remove('active');
      addUserBubble(feed, sentText);
      await wait(450);
      const think = addThinking(feed, step.thinkLabel);
      await wait(step.thinkDuration);
      think.classList.remove('show');
      await wait(220);
      think.remove();
      await streamBubble(feed, step.response, step.streamSpeed);
      await wait(400);
      if (step.showImpact) { addImpactCard(feed); await wait(1500); }
      if (step.followup) await streamBubble(feed, step.followup, step.followupSpeed);
      await wait(step.afterPause);
    }
    await fadeOutFeed(feed);
    await wait(400);
    loopIdx++;
  }
}

/* =================================================================
   PERSONA SCENARIOS, hover/click swap between Maya & Devon visuals
================================================================= */
const personaCards = document.querySelectorAll('.persona-card');
const personaVisuals = document.querySelectorAll('.persona-visual');
let activePersona = 'maya';

function activatePersona(name) {
  if (name === activePersona) return;
  activePersona = name;
  personaCards.forEach(c => {
    const on = c.dataset.persona === name;
    c.classList.toggle('active', on);
    c.setAttribute('aria-selected', String(on));
  });
  personaVisuals.forEach(v => {
    const on = v.dataset.visual === name;
    if (on) {
      // Re-trigger CSS animations by removing then re-adding .active in next frame
      v.classList.remove('active');
      // force reflow so animation restarts cleanly
      void v.offsetWidth;
      v.classList.add('active');
    } else {
      v.classList.remove('active');
    }
  });
}

if (personaCards.length) {
  personaCards.forEach(card => {
    const target = card.dataset.persona;
    card.addEventListener('click', () => activatePersona(target));
    card.addEventListener('mouseenter', () => activatePersona(target));
    card.addEventListener('focus', () => activatePersona(target));
  });
}

/* =================================================================
   SOCIAL PROOF, spots-left count, injected INTO the cap/survey fine line.
   Fills every [data-join-count] fragment from /api/stats on load, e.g.
   "Private Beta 01 · 300 spots · 53 left · survey takers skip the line".
   Spots left = BETA_CAP minus the live signup count. A successful signup ticks
   it down by one. Purely cosmetic: stays hidden if the count is unavailable.
================================================================= */
// Fill every [data-join-count] fragment with the live total. Called on load
// (from /api/stats) AND after a successful signup (from the /api/waitlist
// response's `count`), so the number visibly ticks up to include the new
// signup, regardless of whether the survey is completed, X'd out, or
// dismissed. Function declaration → hoisted, so handleWaitlistSubmit can call it.
const BETA_CAP = 300;  // Private Beta 01 hard cap; counter shows spots remaining
let joinCount = null;  // current signup total (from /api/stats on load)
function renderJoinCount(n) {
  if (typeof n !== 'number' || n < 1) return;
  joinCount = n;
  const left = Math.max(0, BETA_CAP - n);
  // legacy inline fragment (kept harmless wherever present)
  const frag = left > 0 ? ' · ' + left.toLocaleString() + ' spots left' : ' · spots full';
  document.querySelectorAll('[data-join-count]').forEach(function (el) {
    el.textContent = frag;
    el.hidden = false;
  });
  // reassurance jot under the form: "<N> spots left" (hidden until we have a count)
  const slot = document.querySelector('[data-spots-left]');
  const li = document.querySelector('[data-spots-li]');
  if (slot && li && left > 0) {
    slot.textContent = left.toLocaleString() + ' spots left';
    li.hidden = false;
  }
}
// Optimistic +1 after a successful join, no extra /api call. No-op until the
// base count has loaded, so we never render a misleading "1 joined".
function bumpJoinCount() {
  if (typeof joinCount === 'number' && joinCount >= 1) renderJoinCount(joinCount + 1);
}

(function loadJoinCount() {
  if (!document.querySelector('[data-join-count], [data-spots-li]')) return;
  fetch(STATS_ENDPOINT, { headers: { Accept: 'application/json' } })
    .then(function (r) { return r && r.ok ? r.json() : null; })
    .then(function (data) { if (data && data.ok) renderJoinCount(data.count); })
    .catch(function () { /* social proof is optional, silently skip on failure */ });
})();

/* =================================================================
   DRYFT ALGORITHM, live canvas. A scrolling spending line the
   algorithm watches; it forecasts the next slip (line projects over
   plan, in red), fires a nudge, then corrects back to plan, looping
   through its four phases with the cards + status bar in sync.
================================================================= */
(function algoLive() {
  const section = document.getElementById('how-it-works');
  if (!section) return;
  const canvas = section.querySelector('[data-algo-canvas]');
  const chip = section.querySelector('[data-algo-chip]');
  const chipTitle = section.querySelector('[data-chip-title]');
  const chipMsg = section.querySelector('[data-chip-msg]');
  const readout = section.querySelector('[data-readout]');
  const steps = [].slice.call(section.querySelectorAll('.hiw-step'));
  if (!canvas || !canvas.getContext) return;
  const ctx = canvas.getContext('2d');
  let cssW = 0, cssH = 0;

  // Dryft origami-sail mark (256 viewBox) as a Path2D, for the little logo that
  // rides the spending line just behind the "now" dot.
  const MARK = (typeof Path2D !== 'undefined') ? new Path2D(
    'M126 38 L126 110 L64 174 Z' +
    'M126 116 L126 176 L74 176 Z' +
    'M140 70 L140 176 L206 176 Z' +
    'M44 188 L212 188 L180 212 Q128 222 76 212 Z'
  ) : null;
  // Draw the mark with its hull resting at (cx, baseY); `size` ≈ overall height.
  function drawMark(cx, baseY, size, color) {
    if (!MARK) return;
    const s = size / 210;
    ctx.save();
    ctx.translate(cx - 128 * s, baseY - 214 * s);
    ctx.scale(s, s);
    ctx.fillStyle = color;
    ctx.fill(MARK);
    ctx.restore();
  }

  function resize() {
    cssW = canvas.parentNode.clientWidth || 760;
    cssH = canvas.clientHeight || 208;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  // One drift, learned over two passes. Goal: saving $200 this month; the
  // habit is evening takeout. The spending line is a LIVE feed that scrolls
  // right→left; the cards (Predict · Nudge · Watch · Adapt) run TWICE: pass 1
  // the gentle nudge is ignored and spending keeps climbing over the food
  // limit; pass 2 a sharper nudge lands, the line turns back under the limit,
  // and the algorithm learns which tone works for this habit.
  //  level = the live "above the limit" value streaming in at "now" (neg = under)
  //  fc    = where the forecast is headed at the right edge (> 8 reads red / drift)
  //  plan  = 0 normally; ramps to 1 only on the final adapt (limit flattens)
  //  harsh = nudge tone (tints the notification); dur = beat length in seconds
  const BEATS = [
    // ── Pass 1 · the gentle nudge is ignored ──
    { read: 'Spotting the drift, before you feel it', card: 0, dur: 3.2,
      level: 6, fc: 46, plan: 0, notif: null },
    { read: 'A gentle ping, before you buy', card: 1, dur: 3.8,
      level: 18, fc: 40, plan: 0, harsh: false,
      notif: { t: 'Takeout again tonight?', m: 'your 3rd, $38 over. your call.' } },
    { read: 'Learning… you bought it anyway', card: 2, dur: 3.4,
      level: 36, fc: 44, plan: 0, notif: null },
    { read: 'That gentle ping missed, adjusting', card: 3, dur: 2.8,
      level: 39, fc: 42, plan: 0, notif: null },
    // ── Pass 2 · a sharper nudge lands ──
    { read: 'Pinging again, with a different tone', card: 1, dur: 3.8,
      level: 38, fc: 40, plan: 0, harsh: true,
      notif: { t: 'Heads up', m: 'skip it, or rent won\'t be covered.' } },
    { read: 'Learning… you held off this time', card: 2, dur: 3.6,
      level: 4, fc: 3, plan: 0, notif: null },
    { read: 'Tuning the plan, just for you', card: 3, dur: 3.8,
      level: -14, fc: -16, plan: 1,
      notif: { t: 'Plan tuned to you', m: 'a ping with a consequence works best.' } },
  ];
  let beat = -1;
  let levelCur = 6, levelTgt = 6;       // the live "above-limit" value at "now" (neg = under)
  let fcCur = 46,   fcTgt = 46;         // forecast offset at the right edge
  let planCur = 0,  planTgt = 0;        // 0 = base limit; 1 = adapted (flattened) limit
  // the scrolling live feed (right→left): recent above-limit samples, newest last
  let waveHist = [], wavePrevT = null, waveAcc = 0, waveClock = 0;
  const WAVE_HZ = 60, WAVE_WIN = 5.5;   // samples/sec, seconds of history across the wave
  function setBeat(i) {
    if (i === beat) return;
    beat = i;
    const b = BEATS[i];
    levelTgt = b.level; fcTgt = b.fc; planTgt = b.plan;
    if (readout) {
      readout.style.opacity = '0';
      setTimeout(function () { readout.textContent = b.read; readout.style.opacity = '1'; }, 150);
    }
    steps.forEach(function (s, n) { s.classList.toggle('is-active', n === b.card); });
    if (b.notif) {
      if (chipTitle) chipTitle.textContent = b.notif.t;
      if (chipMsg) chipMsg.textContent = b.notif.m;
      if (chip) { chip.classList.toggle('harsh', !!b.harsh); chip.classList.add('show'); }
    } else if (chip) { chip.classList.remove('show'); }
  }

  function draw(tSec) {
    const k = 0.045;
    levelCur += (levelTgt - levelCur) * k;
    fcCur    += (fcTgt    - fcCur   ) * k;
    planCur  += (planTgt  - planCur ) * k;
    const w = cssW, h = cssH;
    ctx.clearRect(0, 0, w, h);
    const x0 = 8, x1 = w - 8, top = 20, bot = h - 16;
    const nowX = x0 + (x1 - x0) * 0.64;
    // the food limit: rises across the month; while adapting (planCur > 0) the
    // slope flattens (right edge eases down) so less is spent over time
    const py = function (x) {
      const u = (x - x0) / (x1 - x0);
      return bot - (bot - top) * (0.34 + (0.18 - 0.13 * planCur) * u);
    };
    ctx.lineWidth = 1; ctx.strokeStyle = 'rgba(13,14,16,0.05)';
    for (let g = 0; g <= 4; g++) { const gy = top + (bot - top) * g / 4; ctx.beginPath(); ctx.moveTo(x0, gy); ctx.lineTo(x1, gy); ctx.stroke(); }
    ctx.setLineDash([5, 6]); ctx.strokeStyle = 'rgba(13,14,16,0.26)'; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(x0, py(x0)); ctx.lineTo(x1, py(x1)); ctx.stroke(); ctx.setLineDash([]);
    ctx.font = '600 10px JetBrains Mono, monospace'; ctx.fillStyle = 'rgba(13,14,16,0.38)';
    ctx.fillText('PLAN', x0 + 2, py(x0) - 6);
    const amp = 7;
    // Spending doesn't oscillate evenly; it holds at a level for a while, then
    // steps to a new one (a quiet stretch, then a spendy one). We build that as a
    // staircase, a level per segment held roughly flat, then smoothstep-eased into
    // the next, so the steps read as gentle waves instead of a sawtooth.
    const hash = (n) => { const s = Math.sin(n * 127.1 + 311.7) * 43758.5453; return s - Math.floor(s); };
    function noise(u) {
      const seg = 3.4;                                    // clock-units each spend level holds
      const s = u / seg, i = Math.floor(s), f = s - i;
      const a = hash(i) * 2 - 1, b = hash(i + 1) * 2 - 1; // this level & the next, -1..1
      const holdFrac = 0.45;                              // flat hold, then ease to the next
      const t = f < holdFrac ? 0 : (f - holdFrac) / (1 - holdFrac);
      const ease = t * t * (3 - 2 * t);                   // smoothstep, no sharp corners
      return (a + (b - a) * ease) + Math.sin(u * 2.1) * 0.05;  // + faint hold-time texture
    }
    // LIVE FEED: push the current above-limit level (+ organic jitter) in at
    // "now" at a fixed rate and let it scroll left into history, so the wave is
    // always moving, the drift builds and the turn travels, never a static pose.
    const maxLen = Math.round(WAVE_HZ * WAVE_WIN);
    const dt = (wavePrevT === null) ? 0 : (tSec - wavePrevT);
    wavePrevT = tSec;
    if (waveHist.length === 0 || dt < 0 || dt > WAVE_WIN) {        // first frame / restart / big jump
      waveHist.length = 0;
      for (let i = 0; i < maxLen; i++) { waveClock++; waveHist.push(levelCur + amp * noise(waveClock * 0.05)); }
      waveAcc = 0;
    } else {
      waveAcc += dt;
      let guard = 0;
      while (waveAcc >= 1 / WAVE_HZ && guard++ < maxLen) {
        waveAcc -= 1 / WAVE_HZ; waveClock++;
        waveHist.push(levelCur + amp * noise(waveClock * 0.05));
      }
      while (waveHist.length > maxLen) waveHist.shift();
    }
    const wn = waveHist.length;
    const stepX = (nowX - x0) / Math.max(1, wn - 1);
    const wy = (j) => py(x0 + j * stepX) - waveHist[j];           // oldest at x0, newest at nowX
    const grad = ctx.createLinearGradient(0, top, 0, bot);
    grad.addColorStop(0, 'rgba(42,129,144,0.16)'); grad.addColorStop(1, 'rgba(42,129,144,0)');
    ctx.beginPath(); ctx.moveTo(x0, bot);
    for (let j = 0; j < wn; j++) ctx.lineTo(x0 + j * stepX, wy(j));
    ctx.lineTo(nowX, bot); ctx.closePath(); ctx.fillStyle = grad; ctx.fill();
    ctx.shadowColor = 'rgba(42,129,144,0.3)'; ctx.shadowBlur = 7;
    ctx.strokeStyle = '#2a8190'; ctx.lineWidth = 2.6; ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    ctx.beginPath();
    for (let j = 0; j < wn; j++) { const y = wy(j); if (j === 0) ctx.moveTo(x0, y); else ctx.lineTo(x0 + j * stepX, y); }
    ctx.stroke(); ctx.shadowBlur = 0;
    const cy = wy(wn - 1), planEnd = py(x1);
    const fEndY = planEnd - fcCur;            // forecast end; above the limit when fcCur > 0
    const drift = fcCur > 8;
    const fcol = drift ? 'rgba(196,77,60,0.82)' : 'rgba(42,129,144,0.72)';
    const mcol = drift ? 'rgba(196,77,60,' : 'rgba(42,129,144,';
    ctx.setLineDash([4, 5]); ctx.lineWidth = 1.8; ctx.strokeStyle = fcol;
    ctx.beginPath(); ctx.moveTo(nowX, cy);
    ctx.quadraticCurveTo((nowX + x1) / 2, (cy + fEndY) / 2 + (drift ? -20 : 10), x1, fEndY);
    ctx.stroke(); ctx.setLineDash([]);
    const pulse = 0.5 + 0.5 * Math.sin(tSec * 2.4);
    ctx.fillStyle = mcol + (0.55 + 0.45 * pulse) + ')';
    ctx.beginPath(); ctx.arc(x1 - 2, fEndY, 4.6, 0, Math.PI * 2); ctx.fill();
    // expanding ripple, drawn first so it sits behind the marker
    const rr = 7 + ((tSec * 16) % 22);
    ctx.lineWidth = 1.5; ctx.strokeStyle = 'rgba(42,129,144,' + Math.max(0, 1 - (rr - 7) / 22) + ')';
    ctx.beginPath(); ctx.arc(nowX, cy, rr, 0, Math.PI * 2); ctx.stroke();
    // the Dryft sail marks "now" on the line (replaces the dot), 50% larger; the
    // mark stays a single solid ink per brand, not recoloured to teal
    drawMark(nowX, cy + 1, 32, '#0a1a22');
  }

  // beats have their own lengths; walk a looping timeline to find the current one
  const TOTAL = BEATS.reduce(function (s, b) { return s + b.dur; }, 0);
  function beatAt(tSec) {
    let t = tSec % TOTAL;
    for (let i = 0; i < BEATS.length; i++) { if (t < BEATS[i].dur) return i; t -= BEATS[i].dur; }
    return BEATS.length - 1;
  }
  let raf = null, t0 = null, running = false;
  function frame(now) {
    if (t0 == null) t0 = now;
    const tSec = (now - t0) / 1000;
    setBeat(beatAt(tSec));
    draw(tSec);
    raf = requestAnimationFrame(frame);
  }
  function start() { if (running) return; running = true; resize(); t0 = null; wavePrevT = null; raf = requestAnimationFrame(frame); }
  function stop() { running = false; if (raf) cancelAnimationFrame(raf); raf = null; }

  resize();
  window.addEventListener('resize', function () { resize(); if (!running) draw(2.0); });
  // initial static frame: the nudge beat (drift + notification), never blank
  setBeat(1); levelCur = levelTgt; fcCur = fcTgt; planCur = planTgt; draw(2.0);
  if (reduceMotion) return;
  // threshold 0: the panel now peeks up into the hero, so start the live render
  // the moment any sliver is on screen (else a small peek renders blank/stale).
  const io = new IntersectionObserver(function (es) {
    es.forEach(function (e) { if (e.isIntersecting) start(); else stop(); });
  }, { threshold: 0 });
  io.observe(section);
})();

/* =================================================================
   REFERRAL CODE LOOKUP (/referral), enter phone, popup shows your code.
================================================================= */
(function wireCodeLookup() {
  const form = document.getElementById('lookup-form');
  const modal = document.getElementById('code-modal');
  if (!form || !modal) return;

  const toggle = document.getElementById('lookup-toggle');
  if (toggle) {
    toggle.addEventListener('click', function () {
      const willOpen = form.hidden;
      form.hidden = !willOpen;
      toggle.setAttribute('aria-expanded', String(willOpen));
      if (willOpen) { const i = document.getElementById('lookup-phone'); if (i) i.focus(); }
    });
  }

  const result = document.getElementById('code-result');
  const notfound = document.getElementById('code-notfound');
  const codeVal = document.getElementById('code-value');
  const codePos = document.getElementById('code-pos');
  const copyBtn = document.getElementById('code-copy');

  function openModal() {
    modal.hidden = false;
    void modal.offsetWidth;
    modal.classList.add('open');
    document.body.classList.add('survey-open');
    setTimeout(function () { modal.querySelector('.code-close')?.focus(); }, 50);
  }
  function closeModal() {
    modal.classList.remove('open');
    document.body.classList.remove('survey-open');
    setTimeout(function () { modal.hidden = true; }, 300);
  }
  modal.querySelectorAll('[data-code-close]').forEach(function (el) { el.addEventListener('click', closeModal); });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && modal.classList.contains('open')) closeModal(); });

  if (copyBtn && codeVal) {
    copyBtn.addEventListener('click', function () {
      const code = (codeVal.textContent || '').trim();
      if (!code || code === '…') return;
      const done = function () {
        const orig = copyBtn.dataset.label || copyBtn.textContent;
        copyBtn.dataset.label = orig;
        copyBtn.textContent = 'Copied';
        setTimeout(function () { copyBtn.textContent = copyBtn.dataset.label || 'Copy'; }, 1500);
      };
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(code).then(done).catch(done);
      else done();
    });
  }

  let lookupBusy = false;
  form.addEventListener('submit', function (e) {
    e.preventDefault();
    if (lookupBusy) return;
    const input = document.getElementById('lookup-phone');
    const btn = form.querySelector('button[type="submit"]');
    const { e164: phone } = readPhone(form);
    if (!isPlausiblePhone(phone)) { shakeForm(form, input); return; }
    lookupBusy = true;
    if (btn) { btn.disabled = true; btn.textContent = 'Checking…'; }
    fetch(LOOKUP_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone: phone }),
    })
      .then(function (r) { return r && r.ok ? r.json() : null; })
      .then(function (data) {
        const found = !!(data && data.ok && data.found);
        if (found) {
          if (codeVal) codeVal.textContent = data.referralCode || '…';
          if (codePos) {
            if (typeof data.position === 'number' && data.position > 0) {
              codePos.textContent = "You're #" + data.position.toLocaleString() + ' on the waitlist';
              codePos.hidden = false;
            } else {
              codePos.hidden = true;
            }
          }
        }
        if (result) result.hidden = !found;
        if (notfound) notfound.hidden = found;
        openModal();
      })
      .catch(function () {
        if (result) result.hidden = true;
        if (notfound) notfound.hidden = false;
        openModal();
      })
      .finally(function () {
        lookupBusy = false;
        if (btn) { btn.disabled = false; btn.textContent = 'Show my code'; }
      });
  });
})();

/* =================================================================
   BOOT
================================================================= */
const notifPhone = document.querySelector('[data-phone="notif"]');
const chatPhone  = document.querySelector('[data-phone="chat"]');
const notifStack = notifPhone && notifPhone.querySelector('[data-notif-stack]');
// Start the hero phone demos. The notification phone inside a pinned scene is
// driven by that scene (scroll-scrub), so don't also auto-loop it here.
function startPhoneDemos() {
  if (notifStack && !notifPhone.hasAttribute('data-pz-phone')) runNotificationLoop(notifStack);
  if (chatPhone) runChatLoop(chatPhone);
}
// Lazy: these phones live below the fold, so only kick off the cascade/chat
// loops once they near the viewport. Visitors who never scroll there never pay
// for the animation. One-shot, then the observer disconnects.
(function lazyStartPhoneDemos() {
  const stage = document.querySelector('.cta-demo') || notifPhone || chatPhone;
  if (!stage) return;
  if (reduceMotion) { startPhoneDemos(); return; }
  let started = false;
  let io = null;
  function go() {
    if (started) return;
    started = true;
    if (io) io.disconnect();
    window.removeEventListener('scroll', go);
    startPhoneDemos();
  }
  // Primary: start when the (below-the-fold) phones near the viewport.
  if ('IntersectionObserver' in window) {
    io = new IntersectionObserver(function (entries) {
      if (entries.some(function (e) { return e.isIntersecting; })) go();
    }, { rootMargin: '200px' });
    io.observe(stage);
  }
  // Fallback: the first scroll guarantees they start. Still lazy, a visitor who
  // never scrolls (and never reaches the phones) never pays for the loops.
  window.addEventListener('scroll', go, { passive: true });
})();

/* ---------------- rotating statement phrase ----------------
   "save without ___" cycles. The first phrase the user sees is always
   "tracking every dollar"; cycling begins on load. */
(function () {
  const el = document.getElementById('statement-rotator');
  if (!el) return;

  const phrases = [
    'tracking every dollar',
    'strict budgets',
    'feeling guilty',
    'monk-like discipline',
  ];
  el.textContent = phrases[0];   // first visible phrase

  if (reduceMotion) return;      // no cycling

  const FADE = 350;   // matches the CSS transition (0.35s)
  const HOLD = 2400;  // visible time per phrase, readable, but still moves on briskly
  let i = 0, started = false;

  function next() {
    el.classList.add('is-out');
    setTimeout(() => {
      i = (i + 1) % phrases.length;
      el.textContent = phrases[i];
      el.classList.remove('is-out');
      setTimeout(next, HOLD);
    }, FADE);
  }
  function start() {
    if (started) return;
    started = true;
    setTimeout(next, HOLD);
  }

  start();   // no loader screen, begin the hero phrase rotator on load
})();
