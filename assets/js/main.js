  // NAV SCROLL
  const nav = document.getElementById('nav');
  window.addEventListener('scroll', () => {
    nav.classList.toggle('scrolled', window.scrollY > 60);
  });

  // SCROLL REVEALS
  const reveals = document.querySelectorAll('.reveal');
  const observer = new IntersectionObserver((entries) => {
    entries.forEach((e, i) => {
      if (e.isIntersecting) {
        setTimeout(() => e.target.classList.add('visible'), i * 80);
        observer.unobserve(e.target);
      }
    });
  }, { threshold: 0.1, rootMargin: '0px 0px -40px 0px' });
  reveals.forEach(r => observer.observe(r));

  // WAITLIST
  const SHEET_WEBHOOK_URL = 'https://script.google.com/macros/s/AKfycbxhbDCy2s1nhtvimGFl5ioW3yvTgnO4p_x4mZElzXjUqaXHzu72NQrD3vFcAzhy0WQmrg/exec';
  let count = 247;

  async function joinWaitlist(source) {
    const emailInput = document.getElementById(source === 'hero' ? 'hero-email' : 'final-email');
    const btn = emailInput.closest('.hero-form, .final-form').querySelector('button');
    const email = emailInput.value.trim();
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

    if (!emailRegex.test(email)) {
      emailInput.style.borderColor = 'var(--red)';
      emailInput.focus();
      setTimeout(() => emailInput.style.borderColor = '', 1500);
      return;
    }

    const originalText = btn.textContent;
    btn.textContent = 'Saving…';
    btn.disabled = true;
    emailInput.disabled = true;

    try {
      if (SHEET_WEBHOOK_URL && SHEET_WEBHOOK_URL !== 'YOUR_APPS_SCRIPT_WEB_APP_URL_HERE') {
        const params = new URLSearchParams({
          email,
          timestamp: new Date().toISOString(),
          source
        });
        await fetch(`${SHEET_WEBHOOK_URL}?${params}`, {
          method: 'GET',
          mode: 'no-cors'
        });
      } else {
        console.warn('Waitlist webhook not configured. Set SHEET_WEBHOOK_URL.');
        console.log('Waitlist signup:', { email, timestamp: new Date().toISOString(), source });
      }
    } catch (err) {
      console.error('Waitlist save failed:', err);
    }

    if (source === 'hero') {
      document.getElementById('hero-form-wrap').style.display = 'none';
      document.getElementById('hero-success').style.display = 'block';
    } else {
      document.getElementById('final-form-wrap').style.display = 'none';
      document.getElementById('final-success').style.display = 'block';
    }

    count++;
    const countEl = document.querySelector('.waitlist-count strong');
    if (countEl) countEl.textContent = count;
  }
  window.joinWaitlist = joinWaitlist;

  document.getElementById('hero-email').addEventListener('keydown', e => {
    if (e.key === 'Enter') joinWaitlist('hero');
  });
  document.getElementById('final-email').addEventListener('keydown', e => {
    if (e.key === 'Enter') joinWaitlist('final');
  });

  /* ===========================================================
     HERO PHONE DEMOS
     Two synchronized scenes that loop forever:
       - Notification phone: alerts slide in from BOTTOM,
         pushing older ones upward until they fade out the top.
       - Chat phone: typing in input bar -> send -> thinking ->
         streaming response -> impact graph generates -> action chip.
     Sequences are pre-baked; relative timing in ms.
  =========================================================== */

  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const wait = (ms) => new Promise(r => setTimeout(r, ms));

  // ---------- NOTIFICATIONS (bottom-up cascade) ----------
  const NOTIFICATIONS = [
    {
      app: 'Dryft',
      time: 'now',
      body: '<strong>Dining drift detected.</strong> You\'re 6 days ahead of plan. Skip one delivery, rent week stays safe.',
      tag: { label: 'Drift', cls: 'warn' },
      extra: '+ $112 over pace',
    },
    {
      app: 'Dryft',
      time: 'just now',
      body: 'Plan is back on track. <strong>Savings buffer secured</strong> for May.',
      tag: { label: 'On plan', cls: 'ok' },
      extra: 'Time to Celebrate!',
    },
    {
      app: 'Dryft',
      time: '2m ago',
      body: 'Netflix and Equinox <strong>renew before rent</strong>. Want a safer cashflow path?',
      tag: { label: 'Cashflow', cls: '' },
      extra: 'Action needed',
    },
    {
      app: 'Dryft',
      time: '14m ago',
      body: '<strong>Coach mode: direct.</strong> Course-correct today, not at month-end. One $64 move fixes it.',
      tag: { label: 'Coach', cls: 'ok' },
      extra: 'Suggested move',
    },
  ];

  function makeNotifNode({ app, time, body, tag, extra }) {
    const el = document.createElement('div');
    el.className = 'notif';
    el.innerHTML = `
      <div class="notif-head">
        <span class="notif-app"><span class="notif-app-icon">D</span>${app}</span>
        <span class="notif-time">${time}</span>
      </div>
      <p class="notif-body">${body}</p>
      <div class="notif-meta">
        <span class="tag ${tag.cls}">${tag.label}</span>
        <span>${extra}</span>
      </div>
    `;
    return el;
  }

  async function runNotificationLoop(stack) {
    if (reduceMotion) {
      // Static: show first 3 notifications stacked
      NOTIFICATIONS.slice(0, 3).forEach((n, i) => {
        const el = makeNotifNode(n);
        el.classList.add('in');
        if (i === 0) el.classList.add('up-2');
        if (i === 1) el.classList.add('up-1');
        stack.appendChild(el);
      });
      return;
    }

    while (true) {
      stack.innerHTML = '';
      const visible = []; // newest last

      for (let i = 0; i < NOTIFICATIONS.length; i++) {
        // Insert new notification at BOTTOM
        const el = makeNotifNode(NOTIFICATIONS[i]);
        stack.appendChild(el);
        visible.push(el);

        // Reflow then animate in
        requestAnimationFrame(() => {
          requestAnimationFrame(() => el.classList.add('in'));
        });

        // Promote older ones: last entry is bottom (new), one above is up-1, etc.
        for (let k = 0; k < visible.length - 1; k++) {
          const node = visible[visible.length - 2 - k];
          if (!node) break;
          node.classList.remove('in', 'up-1', 'up-2', 'up-3');
          if (k === 0) node.classList.add('up-1');
          else if (k === 1) node.classList.add('up-2');
          else node.classList.add('up-3');
        }

        // Trim DOM once they've faded
        while (visible.length > 4) {
          const old = visible.shift();
          setTimeout(() => old.remove(), 600);
        }

        await wait(2400);
      }

      // Hold then reset
      await wait(2200);
      // Fade all out
      visible.forEach((n, idx) => {
        n.classList.add('up-3');
      });
      await wait(700);
    }
  }

  // ---------- CHAT SCENE ----------
  const CHAT_SEQUENCE = [
    {
      typed: 'Can I buy a PS4 this month?',
      typeSpeed: 55,
      thinkLabel: 'Checking your May plan',
      thinkDuration: 1100,
      response: 'Yes — if dining stays under $42/wk and you pause one renewal.',
      streamSpeed: 18,
      afterPause: 1500,
    },
    {
      typed: 'Why did food spike?',
      typeSpeed: 60,
      thinkLabel: 'Finding the pattern',
      thinkDuration: 1300,
      response: 'Takeout is up 38% vs last month. Two delivery apps drove it.',
      streamSpeed: 20,
      showImpact: true,
      followup: 'Add $64 budget for bills and cap delivery this week — plan stays green.',
      followupSpeed: 16,
      afterPause: 2400,
    },
  ];

  async function typeInto(node, text, speed) {
    node.textContent = '';
    for (let i = 0; i < text.length; i++) {
      node.textContent += text[i];
      // Slight humanized jitter
      const jitter = (text[i] === ' ') ? speed * 0.4 : speed * (0.7 + Math.random() * 0.6);
      await wait(jitter);
    }
  }

  function streamBubble(feed, text, speed, role = 'dryft') {
    return new Promise(async (resolve) => {
      const bubble = document.createElement('div');
      bubble.className = `bubble ${role}`;
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
    node.innerHTML = `
      <span class="thinking-label">${label}</span>
      <span class="thinking-dots"><span></span><span></span><span></span></span>
    `;
    feed.appendChild(node);
    requestAnimationFrame(() => node.classList.add('show'));
    return node;
  }

  function addImpactCard(feed) {
    const card = document.createElement('div');
    card.className = 'impact-card';
    card.innerHTML = `
      <div class="impact-head"><strong>Plan impact · May</strong><em>vs target</em></div>
      <div class="impact-bars">
        <div class="impact-bar"><div class="impact-bar-fill" data-h="38"></div></div>
        <div class="impact-bar"><div class="impact-bar-fill red" data-h="92"></div></div>
        <div class="impact-bar"><div class="impact-bar-fill" data-h="54"></div></div>
        <div class="impact-bar"><div class="impact-bar-fill" data-h="68"></div></div>
        <div class="impact-bar"><div class="impact-bar-fill green" data-h="46"></div></div>
      </div>
      <div class="impact-labels">
        <span>Rent</span><span>Food</span><span>Subs</span><span>Gas</span><span>Save</span>
      </div>
      <div class="impact-action">Add $64 → Bills</div>
    `;
    feed.appendChild(card);
    requestAnimationFrame(() => card.classList.add('show'));

    // Animate bars in staggered after the slide-in
    setTimeout(() => {
      card.querySelectorAll('.impact-bar-fill').forEach((bar, i) => {
        setTimeout(() => {
          bar.style.height = `${bar.dataset.h}%`;
        }, i * 110);
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

    if (reduceMotion) {
      // Static final state
      addUserBubble(feed, CHAT_SEQUENCE[1].typed);
      const b = document.createElement('div');
      b.className = 'bubble dryft show';
      b.textContent = CHAT_SEQUENCE[1].response;
      feed.appendChild(b);
      const card = addImpactCard(feed);
      setTimeout(() => {
        card.querySelectorAll('.impact-bar-fill').forEach(bar => bar.style.height = `${bar.dataset.h}%`);
      }, 200);
      return;
    }

    // Brief warm-up so notif phone leads
    await wait(900);

    while (true) {
      for (let s = 0; s < CHAT_SEQUENCE.length; s++) {
        const step = CHAT_SEQUENCE[s];

        // Cursor on
        cursor.classList.add('active');

        // Type into input
        await typeInto(inputText, step.typed, step.typeSpeed);
        await wait(280);

        // Activate send btn
        sendBtn.classList.add('active');
        await wait(140);

        // "Send" — input clears, user bubble appears
        const sentText = inputText.textContent;
        inputText.textContent = '';
        sendBtn.classList.remove('active');
        cursor.classList.remove('active');
        addUserBubble(feed, sentText);
        await wait(450);

        // Thinking
        const think = addThinking(feed, step.thinkLabel);
        await wait(step.thinkDuration);
        think.classList.remove('show');
        await wait(220);
        think.remove();

        // Stream response
        await streamBubble(feed, step.response, step.streamSpeed);
        await wait(400);

        if (step.showImpact) {
          addImpactCard(feed);
          await wait(1500);
        }

        if (step.followup) {
          await streamBubble(feed, step.followup, step.followupSpeed);
        }

        await wait(step.afterPause);
      }

      // Reset: fade feed, then loop
      await fadeOutFeed(feed);
      await wait(400);
    }
  }

  // Boot demos
  const notifPhone = document.querySelector('[data-phone="notif"]');
  const chatPhone = document.querySelector('[data-phone="chat"]');
  const notifStack = notifPhone && notifPhone.querySelector('[data-notif-stack]');
  if (notifStack) runNotificationLoop(notifStack);
  if (chatPhone) runChatLoop(chatPhone);
