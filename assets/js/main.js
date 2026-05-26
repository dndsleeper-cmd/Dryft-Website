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

  try {
    if (SHEET_WEBHOOK_URL && SHEET_WEBHOOK_URL.startsWith('https://')) {
      // URLSearchParams → Content-Type: application/x-www-form-urlencoded.
      // This is what populates Apps Script's e.parameter.email.
      // FormData would set multipart/form-data, which only fills e.postData.contents.
      const body = new URLSearchParams();
      body.set('email', email);
      body.set('source', source);
      body.set('timestamp', new Date().toISOString());
      body.set('dwell_ms', String(now - PAGE_LOAD_TS));
      // mode:'no-cors' = fire-and-forget; we can't read the response (opaque).
      const resp = await fetch(SHEET_WEBHOOK_URL, { method: 'POST', mode: 'no-cors', body });
      console.log('[dryft waitlist] posted', { email, source, type: resp.type });
    } else {
      console.log('[dryft waitlist]', { email, source });
    }
  } catch (err) {
    console.error('[dryft waitlist] save failed:', err);
  }

  showSuccess(source);
  // After the email is captured, prompt the optional product survey.
  // Email is already saved server-side; survey is purely optional follow-up signal.
  openSurvey(email, source);
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
  const sub = surveyForm.querySelector('.survey-submit');
  if (sub) { sub.disabled = false; sub.textContent = 'Send answers'; }
}

function bindSelectGroup(container, hiddenName) {
  const buttons = container.querySelectorAll('button');
  const hidden = surveyForm.querySelector(`input[name="${hiddenName}"]`);
  buttons.forEach(btn => {
    btn.addEventListener('click', () => {
      buttons.forEach(b => {
        b.classList.remove('selected');
        b.setAttribute('aria-checked', 'false');
      });
      btn.classList.add('selected');
      btn.setAttribute('aria-checked', 'true');
      if (hidden) hidden.value = btn.dataset.value;
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

  // Submit — posts survey data to the same Apps Script endpoint with kind=survey
  surveyForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const submitBtn = surveyForm.querySelector('.survey-submit');
    if (!submitBtn) return;
    submitBtn.disabled = true;
    submitBtn.textContent = 'Sending…';

    const data = new FormData(surveyForm);
    const body = new URLSearchParams();
    body.set('kind', 'survey');
    body.set('email', surveyEmail || '');
    body.set('source', surveySource || '');
    body.set('timestamp', new Date().toISOString());
    body.set('stage', data.get('stage') || '');
    ['q1','q2','q3','q4','q5','q6'].forEach(k => body.set(k, data.get(k) || ''));

    try {
      if (SHEET_WEBHOOK_URL && SHEET_WEBHOOK_URL.startsWith('https://')) {
        const resp = await fetch(SHEET_WEBHOOK_URL, { method: 'POST', mode: 'no-cors', body });
        console.log('[dryft survey] posted', { email: surveyEmail, type: resp.type });
      } else {
        console.log('[dryft survey]', Object.fromEntries(body));
      }
    } catch (err) {
      console.error('[dryft survey] save failed:', err);
    }

    // Always show success — fire-and-forget per the no-cors fetch above
    surveyForm.style.display = 'none';
    if (surveySuccess) surveySuccess.hidden = false;
  });
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
          <svg viewBox="0 0 64 64"><path d="M 14 14 L 14 50 L 30 50 C 42 50, 50 42, 50 32 C 50 22, 42 14, 30 14 Z" fill="currentColor"/></svg>
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
