/* =================================================================
   Dryft — landing interactions
   - nav scroll state
   - scroll reveals
   - waitlist submission (CSP-friendly, honeypot + timing bot checks)
   - hero notification cascade
   - hero chat sequence
================================================================= */
'use strict';

const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const wait = (ms) => new Promise(r => setTimeout(r, ms));

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

/* =================================================================
   WAITLIST — anti-abuse posture (front-end only):
     1. Honeypot field (in markup) — bots fill all visible inputs
     2. Short dwell time — instant-submit bots get rejected
     3. Per-form throttle — no spam-clicking submit
     4. Per-page-load rate limit (in-memory) — protects the API endpoint
        from one tab hammering. Resets on reload, which is fine for the threat we
        actually care about (bots, not determined humans).
     5. Strict email validation + sanitization

   The endpoints below are same-origin Vercel serverless functions that
   write to Firestore via the Firebase Admin SDK. Server-side validation
   mirrors the client-side sanitizers as defense in depth — the client is
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
// script hasn't loaded yet. We never block the user on this — if it returns
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
// Local-part: 1-64 chars from a safe subset. Domain: labels of 1-63 chars, TLD 2+ letters.
// Hyphen placed at the end of each class so it's literal without escaping.
const EMAIL_REGEX = /^[A-Za-z0-9._%+-]{1,64}@(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,24}$/;
const DOTSEQ = /\.{2,}/;
let submitCount = 0;
let lastSubmitAt = 0;
const submittedEmails = new Set();

function sanitizeEmail(input) {
  return String(input || '')
    .trim()
    .slice(0, 254)
    .replace(/[^A-Za-z0-9._%+\-@]/g, '');
}
function isPlausibleEmail(email) {
  if (!email || email.length > 254) return false;
  if (DOTSEQ.test(email)) return false;
  if (email.startsWith('.') || email.endsWith('.')) return false;
  if (email.includes('@.') || email.includes('.@')) return false;
  if ((email.match(/@/g) || []).length !== 1) return false;
  return EMAIL_REGEX.test(email);
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
// Tolerant of a missing position — the count query is best-effort server-side.
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
    if (!code || code === '—') return;
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
  const emailInput = form.querySelector('input[type="email"]');
  const honeypot = form.querySelector('input[name="company"]');
  const btn = form.querySelector('button[type="submit"]');
  if (!emailInput || !btn) return;

  // Honeypot — any value means bot. Silent reject.
  if (honeypot && honeypot.value !== '') { form.reset(); return; }

  // Dwell — instant submits are bots
  const now = Date.now();
  if (now - PAGE_LOAD_TS < MIN_HUMAN_DWELL_MS) { shakeForm(form, emailInput); return; }

  // Per-form throttle (prevents accidental double-submits, doesn't block retries)
  if (now - lastSubmitAt < MIN_SUBMIT_INTERVAL_MS) return;

  // Rate limit per page-load. Visible feedback when hit.
  if (submitCount >= MAX_SUBMITS_PER_SESSION) {
    flashButton(btn, 'Too many tries — refresh', 2500);
    return;
  }

  const email = sanitizeEmail(emailInput.value);
  if (!isPlausibleEmail(email)) { shakeForm(form, emailInput); return; }

  // Duplicate in this page-load — show success without re-posting (no enumeration leak).
  const lower = email.toLowerCase();
  if (submittedEmails.has(lower)) { showSuccess(source); return; }

  // All checks passed — commit
  lastSubmitAt = now;
  submitCount++;
  submittedEmails.add(lower);

  btn.textContent = 'Saving…';
  btn.disabled = true;
  emailInput.disabled = true;

  // Show success + open the survey IMMEDIATELY. The Apps Script POST is fired
  // below as fire-and-forget — we don't make the user wait on network latency.
  // mode:'no-cors' means we can't read the response anyway, so awaiting it
  // would just block the UI without any benefit.
  showSuccess(source);
  openSurvey(email, source);
  bumpJoinCount(); // optimistic +1 — the signup is committed; no extra /api pull

  // Optional referral code (only the /referral form carries one). Server
  // sanitizes + validates; we just pass through a trimmed value.
  const codeInput = form.querySelector('input[name="referredByCode"]');
  const referredByCode = codeInput ? String(codeInput.value || '').trim().slice(0, 32) : '';

  // Same-origin POST to our Vercel function — we CAN read the response, so we
  // parse it to surface the user's referral code + position in the survey
  // banner. We still don't block the UI on it (the survey is already open);
  // errors surface in the console and the server write is idempotent.
  getRecaptchaToken('waitlist').then(function (recaptchaToken) {
    const payload = { email: email, source: source, dwell_ms: now - PAGE_LOAD_TS, recaptchaToken: recaptchaToken };
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
  form.addEventListener('submit', (e) => { e.preventDefault(); handleWaitlistSubmit(form, source); });
});

/* =================================================================
   SURVEY MODAL — fired after a successful waitlist submission.
   Email is already captured; this is purely optional signal collection.
   Single-select chips (stage) + 6 Likert scales (0-5).
================================================================= */
const surveyModal = document.getElementById('survey-modal');
const surveyForm = document.getElementById('survey-form');
const surveySuccess = document.getElementById('survey-success');
let surveyEmail = '';
let surveySource = '';
let surveyLastFocus = null;

// --- Progressive autosave state -------------------------------------------
// Every selection is saved to Firebase as it happens (debounced). The server
// keys the doc by the user's email, so changing an answer overwrites it in one
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

function openSurvey(email, source) {
  if (!surveyModal) return;
  surveyEmail = email;
  surveySource = source;
  // Clean autosave state. The doc is keyed server-side by email, so reopening
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
  // If this same email answered before on this browser, pre-fill their prior
  // selections so they can see and continue where they left off.
  restoreSurveyAnswers(email);
  surveyLastFocus = document.activeElement;
  surveyModal.hidden = false;
  // Force reflow before adding .open so the CSS transition fires
  void surveyModal.offsetWidth;
  surveyModal.classList.add('open');
  document.body.classList.add('survey-open');
  // Always open at the top question — both the form (internal scroll on mobile)
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
  // (No-op if they already completed — guarded inside the autosave helper.)
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
  // (The server re-validates against the same allowlists — this is defense in depth.)
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
    e.returnValue = 'Your survey answers are still saving — please wait a moment before closing.';
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
  // the sheet row. Empty strings are fine — q9 is optional.
  // The Apps Script writeRow ALSO applies a formula-injection guard, so this
  // is defense in depth — even if that guard is ever removed, the textarea
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
  // mirrors what's on screen — changing any answer overwrites it.
  function currentSurveyPayload(complete) {
    const data = new FormData(surveyForm);
    const payload = {
      email: sanitizeEmail(surveyEmail || ''),
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
    if (!surveyEmail) return;             // email is the server-side doc key
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
  // no login/email verification, so returning answers by email would leak them
  // to anyone who types that email). Instead we keep a per-email draft in this
  // browser's localStorage purely to PRE-FILL the form when the same email
  // returns here. Accumulating answers into the one server record still works
  // cross-device — this is only the "show what you picked before" convenience.
  const SURVEY_DRAFT_PREFIX = 'dryft.survey.';
  const SURVEY_DRAFT_FIELDS = [
    'careerStage', 'lifeStage',
    'q1', 'q2', 'q3', 'q4', 'q5', 'q6', 'q7', 'q8', 'q9',
  ];
  function draftKey(email) {
    return SURVEY_DRAFT_PREFIX + String(email || '').trim().toLowerCase();
  }
  function saveSurveyDraft() {
    if (!surveyEmail) return;
    try {
      const data = new FormData(surveyForm);
      const answers = {};
      SURVEY_DRAFT_FIELDS.forEach((k) => {
        const v = data.get(k);
        if (v != null && String(v) !== '') answers[k] = String(v);
      });
      localStorage.setItem(draftKey(surveyEmail), JSON.stringify(answers));
    } catch (_) { /* storage unavailable/full — non-fatal */ }
  }
  restoreSurveyAnswers = function (email) {
    let answers;
    try {
      const raw = localStorage.getItem(draftKey(email));
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

  // Derive the question list from the form itself — one hidden input per question.
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

  // Submit — posts survey data to the same Apps Script endpoint with kind=survey
  surveyForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const submitBtn = surveyForm.querySelector('.survey-submit');
    if (!submitBtn) return;

    // Completeness gate — every question must have an answer before we POST.
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

    // Cancel any pending debounced autosave — this complete submit supersedes it.
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
      // generated AT submit time — v3 tokens expire after ~2 minutes.
      payload.recaptchaToken = await getRecaptchaToken('survey');

      // Same-origin POST → we can await the real response (no opaque no-cors).
      // If the server returns non-2xx we still show success — UX-wise, the
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
        } catch (_) { /* body unreadable — position stays null */ }
      }
    } catch (err) {
      console.error('[dryft survey] save failed:', err);
    } finally {
      // Clear the guard whether the POST succeeded or failed — request has at
      // least left the browser by this point.
      isSurveySubmitting = false;
      showSurveySendingNotice(false);
    }

    // Persist the final answers to the local draft, then mark completed so the
    // close/beacon handlers don't overwrite the finished doc with a partial.
    saveSurveyDraft();
    surveyCompleted = true;

    // Always show success — fire-and-forget per the no-cors fetch above
    surveyForm.style.display = 'none';
    // Surface the responder's updated waitlist position when the server gave us one.
    const posEl = document.getElementById('survey-success-pos');
    if (posEl) {
      if (surveyPosition !== null) {
        posEl.textContent = "You're now #" + surveyPosition.toLocaleString() + ' on the waitlist.';
        posEl.hidden = false;
      } else {
        posEl.hidden = true;
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
      notice.innerHTML = '<span class="survey-sending-dot" aria-hidden="true"></span><span>Saving your answers — please don’t close this tab.</span>';
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
   HERO PHONE — NOTIFICATIONS (lock screen cascade)
================================================================= */
const NOTIFICATIONS = [
  { app: 'Dryft', time: 'now', body: '<strong>Dryft caught.</strong> Delivery $112 over. One groceries run gets you back on plan.', tag: { label: 'Fixable', cls: 'warn' }, extra: '+$112 over pace' },
  { app: 'Dryft', time: '2d ago', body: '<strong>Subscriptions hit before payday.</strong> Move one or delay it.', tag: { label: 'Risk', cls: 'warn' }, extra: '2 renewals' },
  { app: 'Dryft', time: '5d ago', body: '<strong>Back on track.</strong> Buffer for March is secured.', tag: { label: 'On plan', cls: 'ok' }, extra: 'Buffer +$86' },
  { app: 'Dryft', time: '1w ago', body: '<strong>Plan adjusted. $64 moved to bills.</strong> All clear.', tag: { label: 'Adjusted', cls: 'ok' }, extra: '$64 moved' },
];

function makeNotifNode({ app, time, body, tag, extra }) {
  const node = document.createElement('div');
  node.className = 'notif';
  node.innerHTML = `
    <div class="notif-head">
      <span class="notif-app">
        <span class="notif-app-icon">
          <svg viewBox="0 0 64 64"><path d="M 8 4 L 56 4 C 58 4, 60 6, 60 8 L 60 56 C 60 58, 58 60, 56 60 L 8 60 C 6 60, 4 58, 4 56 L 4 8 C 4 6, 6 4, 8 4 Z M 14 14 L 14 50 L 30 50 C 42 50, 50 42, 50 32 C 50 22, 42 14, 30 14 Z" fill="currentColor" fill-rule="evenodd"/></svg>
        </span>${app}
      </span>
      <span class="notif-time">${time}</span>
    </div>
    <p class="notif-body">${body}</p>
    <div class="notif-meta">
      <span class="tag ${tag.cls}">${tag.label}</span>
      <span>${extra}</span>
    </div>
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
   HERO PHONE — CHAT (looping conversation)
================================================================= */
const CHAT_SEQUENCE = [
  { typed: 'Can I order takeout tonight?', typeSpeed: 55, thinkLabel: 'Checking plan', thinkDuration: 1100, response: 'Yes, under $24 and skip Friday\'s.', streamSpeed: 18, afterPause: 1800 },
  { typed: 'Why is food up this week?', typeSpeed: 60, thinkLabel: 'Finding the pattern', thinkDuration: 1300, response: 'Delivery is +38% vs last week.', streamSpeed: 20, showImpact: true, followup: 'Cap delivery to 2 this week.', followupSpeed: 16, afterPause: 2400 },
];

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
  while (true) {
    for (const step of CHAT_SEQUENCE) {
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
  }
}

/* =================================================================
   PERSONA SCENARIOS — hover/click swap between Maya & Devon visuals
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
   SOCIAL PROOF — live signup count, injected INTO the cap/survey fine line.
   Fills every [data-join-count] fragment from /api/stats on load, e.g.
   "Private Beta 01 · 300 spots · 247 joined · survey takers skip the line".
   Purely cosmetic: the fragment stays hidden if the count is unavailable / < 1.
================================================================= */
// Fill every [data-join-count] fragment with the live total. Called on load
// (from /api/stats) AND after a successful signup (from the /api/waitlist
// response's `count`), so the number visibly ticks up to include the new
// signup — regardless of whether the survey is completed, X'd out, or
// dismissed. Function declaration → hoisted, so handleWaitlistSubmit can call it.
let joinCount = null; // current displayed total (from /api/stats on load)
function renderJoinCount(n) {
  if (typeof n !== 'number' || n < 1) return;
  joinCount = n;
  const frag = ' · ' + n.toLocaleString() + ' joined';
  document.querySelectorAll('[data-join-count]').forEach(function (el) {
    el.textContent = frag;
    el.hidden = false;
  });
}
// Optimistic +1 after a successful join — no extra /api call. No-op until the
// base count has loaded, so we never render a misleading "1 joined".
function bumpJoinCount() {
  if (typeof joinCount === 'number' && joinCount >= 1) renderJoinCount(joinCount + 1);
}

(function loadJoinCount() {
  if (!document.querySelector('[data-join-count]')) return;
  fetch(STATS_ENDPOINT, { headers: { Accept: 'application/json' } })
    .then(function (r) { return r && r.ok ? r.json() : null; })
    .then(function (data) { if (data && data.ok) renderJoinCount(data.count); })
    .catch(function () { /* social proof is optional — silently skip on failure */ });
})();

/* =================================================================
   REFERRAL CODE LOOKUP (/referral) — enter email, popup shows your code.
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
      if (willOpen) { const i = document.getElementById('lookup-email'); if (i) i.focus(); }
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
      if (!code || code === '—') return;
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
    const input = document.getElementById('lookup-email');
    const btn = form.querySelector('button[type="submit"]');
    const email = sanitizeEmail(input ? input.value : '');
    if (!isPlausibleEmail(email)) { shakeForm(form, input); return; }
    lookupBusy = true;
    if (btn) { btn.disabled = true; btn.textContent = 'Checking…'; }
    fetch(LOOKUP_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: email }),
    })
      .then(function (r) { return r && r.ok ? r.json() : null; })
      .then(function (data) {
        const found = !!(data && data.ok && data.found);
        if (found) {
          if (codeVal) codeVal.textContent = data.referralCode || '—';
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
if (notifStack) runNotificationLoop(notifStack);
if (chatPhone) runChatLoop(chatPhone);
