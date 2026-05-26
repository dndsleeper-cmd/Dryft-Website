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
     4. Per-page-load rate limit (in-memory) — protects the Apps Script endpoint
        from one tab hammering. Resets on reload, which is fine for the threat we
        actually care about (bots, not determined humans).
     5. Strict email validation + sanitization
================================================================= */
const SHEET_WEBHOOK_URL = 'https://script.google.com/macros/s/AKfycbxhbDCy2s1nhtvimGFl5ioW3yvTgnO4p_x4mZElzXjUqaXHzu72NQrD3vFcAzhy0WQmrg/exec';
const PAGE_LOAD_TS = Date.now();
const MIN_HUMAN_DWELL_MS = 1200;
const MIN_SUBMIT_INTERVAL_MS = 800;
const MAX_SUBMITS_PER_SESSION = 5;
// Local-part: 1-64 chars from a safe subset. Domain: labels of 1-63 chars, TLD 2+ letters.
const EMAIL_REGEX = /^[A-Za-z0-9._%+\-]{1,64}@(?:[A-Za-z0-9](?:[A-Za-z0-9\-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,24}$/;
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
function showSuccess(source) {
  if (source === 'hero') {
    const f = document.getElementById('hero-form'); const s = document.getElementById('hero-success');
    if (f) f.style.display = 'none';
    if (s) s.style.display = 'block';
  } else {
    const f = document.getElementById('final-form'); const s = document.getElementById('final-success');
    if (f) f.style.display = 'none';
    if (s) s.style.display = 'block';
  }
}

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

  if (SHEET_WEBHOOK_URL && SHEET_WEBHOOK_URL.startsWith('https://')) {
    // URLSearchParams → Content-Type: application/x-www-form-urlencoded.
    // This is what populates Apps Script's e.parameter.email.
    // FormData would set multipart/form-data, which only fills e.postData.contents.
    const body = new URLSearchParams();
    body.set('email', email);
    body.set('source', source);
    body.set('timestamp', new Date().toISOString());
    body.set('dwell_ms', String(now - PAGE_LOAD_TS));
    // Background POST — does not block the modal. Errors are reported quietly;
    // we don't log success because no-cors returns opaque responses anyway.
    fetch(SHEET_WEBHOOK_URL, { method: 'POST', mode: 'no-cors', body })
      .catch(err => console.error('[dryft waitlist] save failed:', err));
  } else if (typeof console !== 'undefined') {
    // Dev-only path when no webhook is configured — shows the payload locally.
    console.info('[dryft waitlist · dev]', { email, source });
  }
}

['hero-form', 'final-form'].forEach((id) => {
  const form = document.getElementById(id);
  if (!form) return;
  const source = id === 'hero-form' ? 'hero' : 'final';
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

function openSurvey(email, source) {
  if (!surveyModal) return;
  surveyEmail = email;
  surveySource = source;
  // Reset selections + form state in case the modal was opened earlier in this session
  resetSurvey();
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
  const VALID_STAGES = new Set([
    'High school student',
    'University / college student',
    'Early career professional',
    'Mid-career professional',
    'Parent / family stage',
    'Retired'
  ]);
  // Likert scale: empty string (unanswered) or "1"–"5"
  const VALID_SCALE = new Set(['', '1', '2', '3', '4', '5']);
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

  function sanitizeStage(v) {
    const s = String(v == null ? '' : v).trim().slice(0, 64);
    return VALID_STAGES.has(s) ? s : '';
  }
  function sanitizeScale(v) {
    // Reject anything that isn't exactly "" or "1".."5"
    const s = String(v == null ? '' : v).trim();
    return VALID_SCALE.has(s) ? s : '';
  }

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

    submitBtn.disabled = true;
    submitBtn.textContent = 'Sending…';
    // Mark in-flight + show the inline "don't close this tab" notice
    isSurveySubmitting = true;
    showSurveySendingNotice(true);

    const data = new FormData(surveyForm);
    const body = new URLSearchParams();
    body.set('kind', 'survey');
    // Re-sanitize the email here too — surveyEmail came from sanitizeEmail() earlier,
    // but we re-validate before posting in case the reference was tampered with.
    body.set('email', sanitizeEmail(surveyEmail || ''));
    body.set('source', String(surveySource || '').replace(/[^a-z]/gi, '').slice(0, 16));
    body.set('timestamp', new Date().toISOString());
    body.set('stage', sanitizeStage(data.get('stage')));
    ['q1','q2','q3','q4','q5','q6'].forEach(k => body.set(k, sanitizeScale(data.get(k))));

    try {
      if (SHEET_WEBHOOK_URL && SHEET_WEBHOOK_URL.startsWith('https://')) {
        await fetch(SHEET_WEBHOOK_URL, { method: 'POST', mode: 'no-cors', body });
      } else if (typeof console !== 'undefined') {
        // Dev-only path when no webhook is configured.
        console.info('[dryft survey · dev]', Object.fromEntries(body));
      }
    } catch (err) {
      console.error('[dryft survey] save failed:', err);
    } finally {
      // Clear the guard whether the POST succeeded or failed — request has at
      // least left the browser by this point with no-cors mode.
      isSurveySubmitting = false;
      showSurveySendingNotice(false);
    }

    // Always show success — fire-and-forget per the no-cors fetch above
    surveyForm.style.display = 'none';
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
  { app: 'Dryft', time: 'now', body: '<strong>Day 9 catch.</strong> Delivery $112 over. One groceries run gets you back on plan.', tag: { label: 'Fixable', cls: 'warn' }, extra: '+$112 over pace' },
  { app: 'Dryft', time: '2d ago', body: '<strong>Subscriptions hit before payday.</strong> Move one or delay it.', tag: { label: 'Risk', cls: 'warn' }, extra: '2 renewals' },
  { app: 'Dryft', time: '5d ago', body: '<strong>Back on track.</strong> Buffer for March is secured.', tag: { label: 'On plan', cls: 'ok' }, extra: 'Buffer +$86' },
  { app: 'Dryft', time: '1w ago', body: '<strong>Plan adjusted — $64 moved to bills.</strong> All clear.', tag: { label: 'Adjusted', cls: 'ok' }, extra: '$64 moved' },
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
  { typed: 'Can I order takeout tonight?', typeSpeed: 55, thinkLabel: 'Checking plan', thinkDuration: 1100, response: 'Yes — under $24 and skip Friday\'s.', streamSpeed: 18, afterPause: 1800 },
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
function streamBubble(feed, text, speed) {
  return new Promise(async (resolve) => {
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
    resolve(bubble);
  });
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
function fadeOutFeed(feed) {
  return new Promise(async (resolve) => {
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
    resolve();
  });
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
   BOOT
================================================================= */
const notifPhone = document.querySelector('[data-phone="notif"]');
const chatPhone  = document.querySelector('[data-phone="chat"]');
const notifStack = notifPhone && notifPhone.querySelector('[data-notif-stack]');
if (notifStack) runNotificationLoop(notifStack);
if (chatPhone) runChatLoop(chatPhone);
