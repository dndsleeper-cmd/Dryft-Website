/* ===========================================================
   DRYFT · hero ocean scene
   ---------------------------------------------------------------
   A self-hosted, dependency-free canvas animation for the landing
   hero. No three.js / no CDN, so it stays inside the site CSP
   (script-src 'self') and never blocks the LCP.

   The visual is the brand metaphor made literal: a sailboat that
     1. holds a heading (you set a course / a goal),
     2. drifts off the wind (life pushes you off plan),
     3. gets trimmed back onto the course line (Dryft corrects you),
   looping forever with a soft teal "nudge" pulse on every correction.

   Progressive enhancement: the canvas paints over the static hero
   photo (.statement-bg). If JS is disabled or the scene throws, the
   photo remains as the fallback and nothing is lost.
   =========================================================== */
(function () {
  'use strict';

  var canvas = document.querySelector('.statement-canvas');
  if (!canvas) return;
  var ctx = canvas.getContext('2d');
  if (!ctx) return; // very old browser: keep the photo fallback

  var reduceMotion =
    window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // Logical (CSS px) scene size; backing store is scaled by DPR in resize().
  var W = 0,
    H = 0,
    dpr = 1;
  var horizonY = 0; // y of the waterline / horizon
  var stars = []; // precomputed star field {x,y,r,tw}
  var started = false; // becomes true once the first frame paints

  // --- palette (matches the dark teal ocean brand) ---
  var SKY_TOP = '#03070b';
  var SKY_MID = '#071c28';
  var SKY_HORIZON = '#0e3a45';
  var WATER_TOP = '#0c3742';
  var GLOW = [126, 206, 214]; // cool teal-white moon glow (rgb)
  var TEAL = [46, 129, 144]; // brand accent for the nudge pulse
  var LINE = [42, 129, 144]; // #2a8190, the brand accent (matches the algo line)
  var DRIFT = [196, 77, 60]; // #c44d3c, the algo's "over plan" forecast red
  // The sea surface IS the data line: the same teal stroke as the Dryft Algo
  // graph below. The boat sails it; spending swells lift the line (and tint it
  // red ahead, the forecast), the nudge fires, and it eases back onto plan.
  // The boat holds station here, just right of the centred headline.
  var COURSE_X = 0.78;

  function rgba(rgb, a) {
    return 'rgba(' + rgb[0] + ',' + rgb[1] + ',' + rgb[2] + ',' + a + ')';
  }
  function mix(a, b, k) {
    return [
      Math.round(a[0] + (b[0] - a[0]) * k),
      Math.round(a[1] + (b[1] - a[1]) * k),
      Math.round(a[2] + (b[2] - a[2]) * k),
    ];
  }
  function clamp01(v) {
    return v < 0 ? 0 : v > 1 ? 1 : v;
  }

  // The sea surface as a function of x: a gentle ambient swell plus a localized
  // "spend" bump centred on the boat that grows with the drift magnitude. The
  // line rises (smaller y) as spending climbs, exactly like the algo graph.
  function ambientY(x, t) {
    return Math.sin(x * 0.011 + t * 0.7) * 3.4 + Math.sin(x * 0.026 - t * 1.05) * 1.8;
  }
  function surfaceY(x, t, e) {
    var bx = W * COURSE_X;
    var sw = Math.max(150, W * 0.17); // swell half-width
    var d = (x - bx) / sw;
    var swell = e * (H * 0.085) * Math.exp(-d * d); // Gaussian bump under the boat
    return horizonY - ambientY(x, t) - swell;
  }

  // ---------------------------------------------------------------
  // Sizing
  // ---------------------------------------------------------------
  function resize() {
    var rect = canvas.getBoundingClientRect();
    W = Math.max(1, rect.width);
    H = Math.max(1, rect.height);
    dpr = Math.min(window.devicePixelRatio || 1, 2); // cap DPR for perf
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    horizonY = Math.round(H * 0.585);
    buildStars();
  }

  // Deterministic pseudo-random so the star field is stable across
  // resizes within a session (and we avoid Math.random churn).
  var seed = 1337;
  function rnd() {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  }
  function buildStars() {
    seed = 1337;
    stars = [];
    var count = Math.round((W * horizonY) / 14000);
    count = Math.max(18, Math.min(70, count));
    for (var i = 0; i < count; i++) {
      stars.push({
        x: rnd() * W,
        y: rnd() * (horizonY * 0.82),
        r: 0.4 + rnd() * 1.1,
        tw: rnd() * Math.PI * 2, // twinkle phase
      });
    }
  }

  // ---------------------------------------------------------------
  // Drift narrative: a looping course-error in [-1, 1].
  // 0 = on course, ±1 = fully drifted. Direction alternates each
  // cycle. Returns { err, correcting, pulse } where pulse spikes at
  // the moment the correction (the "nudge") begins, then decays.
  // ---------------------------------------------------------------
  var PERIOD = 11; // seconds per full hold→drift→correct→hold loop
  function easeInOut(t) {
    return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
  }
  function course(time) {
    var cycle = Math.floor(time / PERIOD);
    var p = (time % PERIOD) / PERIOD; // 0..1 within the cycle
    var dir = cycle % 2 === 0 ? 1 : -1; // alternate drift side
    var err = 0,
      correcting = false,
      pulse = 0;

    if (p < 0.16) {
      // hold on course
      err = 0;
    } else if (p < 0.46) {
      // drift off the wind
      err = easeInOut((p - 0.16) / 0.3);
    } else if (p < 0.56) {
      // hang off-course briefly
      err = 1;
    } else if (p < 0.8) {
      // Dryft trims us back
      correcting = true;
      err = 1 - easeInOut((p - 0.56) / 0.24);
      // pulse: bright at correction start (p=0.56), decays out
      pulse = Math.max(0, 1 - (p - 0.56) / 0.18);
    } else {
      // settle back on course
      err = 0;
    }
    return { err: err * dir, correcting: correcting, pulse: pulse };
  }

  // ---------------------------------------------------------------
  // Scene drawing
  // ---------------------------------------------------------------
  function drawSky() {
    var g = ctx.createLinearGradient(0, 0, 0, horizonY);
    g.addColorStop(0, SKY_TOP);
    g.addColorStop(0.6, SKY_MID);
    g.addColorStop(1, SKY_HORIZON);
    ctx.fillStyle = g;
    // fill the whole canvas; the water (drawn next) covers everything below the
    // surface line, which can rise a little above horizonY on a spend swell
    ctx.fillRect(0, 0, W, H);
  }

  function drawStars(t) {
    for (var i = 0; i < stars.length; i++) {
      var s = stars[i];
      var a = 0.25 + 0.55 * (0.5 + 0.5 * Math.sin(t * 1.4 + s.tw));
      ctx.beginPath();
      ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(214,236,240,' + a.toFixed(3) + ')';
      ctx.fill();
    }
  }

  // An occasional shooting star: fires roughly every 1-2 minutes and streaks
  // across the upper sky for about a second. Deterministic per cycle (no RNG).
  function meteorHash(n) {
    var x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
    return x - Math.floor(x);
  }
  function drawMeteor(t) {
    var period = 30; // one meteor every 30s...
    var cyc = Math.floor(t / period);
    var local = t - cyc * period;
    var fireAt = 3; // ...with the first ~3s after load (within 5s)
    var dur = 1.2;
    if (local < fireAt || local > fireAt + dur) return;
    var prog = (local - fireAt) / dur; // 0..1
    var sx = (0.08 + meteorHash(cyc * 2 + 1) * 0.7) * W;
    var sy = (0.05 + meteorHash(cyc * 3 + 2) * 0.32) * horizonY;
    var ang = 0.32 + meteorHash(cyc * 5 + 4) * 0.5; // shallow dive, down-right
    var travel = W * 0.5;
    var hx = sx + Math.cos(ang) * travel * prog;
    var hy = sy + Math.sin(ang) * travel * prog;
    var len = 150;
    var fade = Math.sin(prog * Math.PI); // ease in and out
    var g = ctx.createLinearGradient(hx - Math.cos(ang) * len, hy - Math.sin(ang) * len, hx, hy);
    g.addColorStop(0, 'rgba(220,238,242,0)');
    g.addColorStop(1, 'rgba(232,245,249,' + (0.7 * fade).toFixed(3) + ')');
    ctx.strokeStyle = g;
    ctx.lineWidth = 1.6;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(hx - Math.cos(ang) * len, hy - Math.sin(ang) * len);
    ctx.lineTo(hx, hy);
    ctx.stroke();
    ctx.fillStyle = 'rgba(240,250,252,' + (0.9 * fade).toFixed(3) + ')';
    ctx.beginPath();
    ctx.arc(hx, hy, 1.8, 0, Math.PI * 2);
    ctx.fill();
  }

  // Moon / low sun glow sitting just above the horizon, slightly
  // right of centre, providing the light the water reflects.
  var moonX = 0;
  function drawGlow() {
    moonX = W * 0.81;
    var moonY = horizonY - H * 0.22;
    var r = Math.max(W, H) * 0.5;
    var g = ctx.createRadialGradient(moonX, moonY, 0, moonX, moonY, r);
    g.addColorStop(0, rgba(GLOW, 0.55));
    g.addColorStop(0.18, rgba(GLOW, 0.18));
    g.addColorStop(0.45, rgba(GLOW, 0.05));
    g.addColorStop(1, rgba(GLOW, 0));
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, horizonY + H * 0.1);

    // crisp moon disc
    ctx.beginPath();
    ctx.arc(moonX, moonY, Math.max(10, W * 0.018), 0, Math.PI * 2);
    var mg = ctx.createRadialGradient(moonX, moonY, 0, moonX, moonY, Math.max(10, W * 0.018));
    mg.addColorStop(0, 'rgba(236,248,250,0.95)');
    mg.addColorStop(1, 'rgba(190,224,228,0.4)');
    ctx.fillStyle = mg;
    ctx.fill();
  }

  // A subtle orca silhouette gliding slowly through the deep water (its tall
  // back-swept dorsal fin is the tell). Drawn inside the water clip so it always
  // stays below the surface; very low opacity so it reads as a quiet hint of life.
  function drawOrca(t) {
    var span = W + 280;
    // start ~18% across so it's on screen immediately on load, then drift steadily
    // right at ~13px/s (20% faster than before), wrapping around
    var wx = ((t * 13.2 + W * 0.18 + 140) % span) - 140;
    var wy = horizonY + (H - horizonY) * 0.44; // kept in the darker water, not the lightening seam
    var s = Math.max(0.55, Math.min(1.1, W / 1400));
    var cy = wy + Math.sin(t * 0.5) * 6 * s; // gentle rise/fall as it swims
    ctx.save();
    ctx.globalAlpha = 0.17; // reads as a clear silhouette on the dark teal water
    ctx.fillStyle = '#02080c';

    // body: head to the right, tapering toward the tail on the left
    ctx.beginPath();
    ctx.ellipse(wx, cy, 66 * s, 16 * s, -0.05, 0, Math.PI * 2);
    ctx.fill();

    // tall back-swept dorsal fin (the orca's signature), mid-back
    ctx.beginPath();
    ctx.moveTo(wx + 14 * s, cy - 11 * s);
    ctx.quadraticCurveTo(wx + 8 * s, cy - 41 * s, wx - 15 * s, cy - 42 * s);
    ctx.quadraticCurveTo(wx - 3 * s, cy - 23 * s, wx - 5 * s, cy - 11 * s);
    ctx.closePath();
    ctx.fill();

    // tail fluke (left)
    ctx.beginPath();
    ctx.moveTo(wx - 58 * s, cy);
    ctx.quadraticCurveTo(wx - 90 * s, cy - 22 * s, wx - 104 * s, cy - 26 * s);
    ctx.quadraticCurveTo(wx - 84 * s, cy - 2 * s, wx - 90 * s, cy + 18 * s);
    ctx.quadraticCurveTo(wx - 72 * s, cy + 5 * s, wx - 58 * s, cy);
    ctx.closePath();
    ctx.fill();

    // pectoral fin (paddle-shaped, swept back below the front of the body)
    ctx.beginPath();
    ctx.moveTo(wx + 20 * s, cy + 7 * s);
    ctx.quadraticCurveTo(wx + 2 * s, cy + 27 * s, wx - 10 * s, cy + 23 * s);
    ctx.quadraticCurveTo(wx + 6 * s, cy + 12 * s, wx + 20 * s, cy + 7 * s);
    ctx.closePath();
    ctx.fill();

    ctx.restore();
  }

  // Trace the surface line across the canvas into the current path.
  function surfacePath(t, e, step) {
    for (var x = -10; x <= W + 10; x += step) {
      var y = surfaceY(x, t, e);
      if (x === -10) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
  }

  function drawWater(t, e) {
    // water body: everything below the surface line
    ctx.save();
    ctx.beginPath();
    surfacePath(t, e, 14);
    ctx.lineTo(W + 10, H);
    ctx.lineTo(-10, H);
    ctx.closePath();
    ctx.clip(); // confine the fills below to the water shape

    // the sea holds its teal through the upper water, then lightens all the way to
    // the page white at the bottom, so the hero dissolves straight into the page
    var g = ctx.createLinearGradient(0, horizonY - H * 0.1, 0, H);
    g.addColorStop(0, WATER_TOP);
    g.addColorStop(0.45, '#0c3742');
    g.addColorStop(0.68, '#3e5a62');
    g.addColorStop(0.85, '#97a9ae');
    g.addColorStop(1, '#f4f6f7');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);

    // a slow orca silhouette gliding through the deep (a quiet bit of life you
    // notice as the sea carries you down into the page)
    drawOrca(t);

    // moon reflection: a shimmering streak anchored to the wavy surface under the
    // moon and rippling WITH it (phase tied to -t so the highlights travel down)
    var colW = Math.max(W * 0.09, 64);
    var surfM = surfaceY(moonX, t, e);
    for (var yy = surfM; yy < H; yy += 3) {
      var p = (yy - surfM) / (H - surfM); // 0 at the surface, 1 at the bottom
      var wob = Math.sin(yy * 0.1 - t * 2.6) * (3 + p * 16);
      var a = 0.2 * (1 - p) * (0.5 + 0.5 * Math.sin(yy * 0.26 - t * 3.4));
      if (a <= 0.01) continue;
      ctx.fillStyle = rgba(GLOW, a.toFixed(3));
      ctx.fillRect(moonX + wob - colW / 2, yy, colW, 2);
    }

    // surface texture: wave-highlight lines spread evenly down the water column
    // (not bunched at the top), their opacity fading out exactly as the sea
    // lightens toward white, so the dynamic wave itself carries the transition all
    // the way down into the page rather than a flat colour ramp finishing the job
    var n = 7;
    var waterSpan = H - horizonY;
    for (var i = 0; i < n; i++) {
      var df = 0.05 + (i / (n - 1)) * 0.82; // even spread, just below surface → deep
      var y = horizonY + df * waterSpan;
      var amp = 1.4 + df * df * 15;
      var speed = 0.5 + df * 1.9;
      var s = clamp01((df - 0.48) / 0.36);
      var fade = 1 - s * s * (3 - 2 * s); // full in the dark water, gone by the white
      var alpha = 0.13 * fade;
      if (alpha < 0.004) continue;
      ctx.beginPath();
      for (var x = -10; x <= W + 10; x += 12) {
        var yy2 =
          y +
          Math.sin(x * 0.012 + t * speed + i) * amp +
          Math.sin(x * 0.043 - t * speed * 0.7) * amp * 0.35;
        if (x === -10) ctx.moveTo(x, yy2);
        else ctx.lineTo(x, yy2);
      }
      ctx.strokeStyle = rgba(GLOW, alpha.toFixed(3));
      ctx.lineWidth = 0.8 + fade * 0.7;
      ctx.stroke();
    }
    ctx.restore();
  }

  // The surface line drawn as the glowing teal spending line: a soft fill just
  // beneath it, then the bright stroke. Ahead of the boat the stroke warms to
  // the algo's "over plan" red while spending is drifting over the limit.
  function drawDataLine(t, e, redAmt) {
    var bx = W * COURSE_X;

    // soft gradient fill hugging the underside of the line (like the algo)
    ctx.save();
    ctx.beginPath();
    surfacePath(t, e, 14);
    ctx.lineTo(W + 10, horizonY + 54);
    ctx.lineTo(-10, horizonY + 54);
    ctx.closePath();
    var fill = ctx.createLinearGradient(0, horizonY - 30, 0, horizonY + 54);
    fill.addColorStop(0, rgba(LINE, 0.22));
    fill.addColorStop(1, rgba(LINE, 0));
    ctx.fillStyle = fill;
    ctx.fill();
    ctx.restore();

    // the bright line itself, with a teal glow; colour ramps teal→red to the
    // right of the boat as the forecast drifts over plan
    var rightCol = mix(LINE, DRIFT, redAmt);
    var grad = ctx.createLinearGradient(0, 0, W, 0);
    grad.addColorStop(0, rgba(LINE, 0.95));
    grad.addColorStop(clamp01(bx / W), rgba(LINE, 0.95));
    grad.addColorStop(1, rgba(rightCol, 0.95));
    ctx.beginPath();
    surfacePath(t, e, 8);
    ctx.strokeStyle = grad;
    ctx.lineWidth = 2.6;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.shadowColor = rgba(mix(LINE, DRIFT, redAmt * 0.6), 0.45);
    ctx.shadowBlur = 8;
    ctx.stroke();
    ctx.shadowBlur = 0;
  }

  // A single sail triangle with a soft luff curve and gradient.
  function sail(ax, ay, bx, by, cx, cy, lit) {
    ctx.beginPath();
    ctx.moveTo(ax, ay);
    // curved leech for a wind-filled belly
    var mx = (ax + bx) / 2 + (bx - ax) * 0.1;
    var my = (ay + by) / 2;
    ctx.quadraticCurveTo(mx, my, bx, by);
    ctx.lineTo(cx, cy);
    ctx.closePath();
    var g = ctx.createLinearGradient(cx, cy, ax, ay);
    g.addColorStop(0, lit ? '#fffdf7' : '#e7e0d2');
    g.addColorStop(1, lit ? '#d8d0bf' : '#b9b2a3');
    ctx.fillStyle = g;
    ctx.fill();
  }

  function drawBoat(t, c) {
    var e = Math.abs(c.err);
    var cx = W * COURSE_X; // holds station; the line rises under it, not sideways
    var bob = Math.sin(t * 1.25) * 1.6; // tiny float on top of the line
    var wl = surfaceY(cx, t, e) + bob; // sit the hull on the data line
    // tilt with the local slope of the line, plus a small wind lean while drifting
    var slope = (surfaceY(cx + 6, t, e) - surfaceY(cx - 6, t, e)) / 12;
    var heel = Math.atan(slope) + e * 0.05 + Math.sin(t * 1.1) * 0.01;
    var s = Math.max(0.42, Math.min(0.7, W / 1700)); // responsive scale

    // teal "nudge" pulse ring when Dryft trims the line back onto plan
    if (c.pulse > 0.01) {
      var pr = (1 - c.pulse) * 120 * s + 16;
      ctx.beginPath();
      ctx.arc(cx, wl - 30 * s, pr, 0, Math.PI * 2);
      ctx.strokeStyle = rgba(TEAL, (c.pulse * 0.5).toFixed(3));
      ctx.lineWidth = 2;
      ctx.stroke();
    }

    // ---- reflection (drawn first, under the hull) ----
    ctx.save();
    ctx.translate(cx, wl);
    ctx.scale(1, -0.5); // mirror + squish into the water
    ctx.rotate(-heel);
    ctx.globalAlpha = 0.18;
    paintBoatBody(s, t, false);
    ctx.restore();

    // ---- the boat itself ----
    ctx.save();
    ctx.translate(cx, wl);
    ctx.rotate(heel);
    paintBoatBody(s, t, true);
    ctx.restore();
  }

  // Draws hull + mast + sails around a local origin sitting at the
  // waterline. `lit` true for the real boat, false-ish for reflection.
  function paintBoatBody(s, t, lit) {
    var hullW = 104 * s;
    var hullH = 22 * s;
    var mastH = 132 * s;

    // hull: a smooth keel-shaped wedge
    ctx.beginPath();
    ctx.moveTo(-hullW / 2, -hullH * 0.35);
    ctx.quadraticCurveTo(0, hullH * 1.05, hullW / 2, -hullH * 0.35);
    ctx.lineTo(hullW * 0.4, -hullH * 0.6);
    ctx.lineTo(-hullW * 0.46, -hullH * 0.6);
    ctx.closePath();
    var hg = ctx.createLinearGradient(0, -hullH, 0, hullH);
    hg.addColorStop(0, '#16323b');
    hg.addColorStop(1, '#0a1d24');
    ctx.fillStyle = hg;
    ctx.fill();
    // teal rim light along the deck
    ctx.strokeStyle = rgba(GLOW, lit ? 0.5 : 0.3);
    ctx.lineWidth = 1.3;
    ctx.beginPath();
    ctx.moveTo(-hullW * 0.46, -hullH * 0.6);
    ctx.lineTo(hullW * 0.4, -hullH * 0.6);
    ctx.stroke();

    // mast
    var deckY = -hullH * 0.6;
    ctx.strokeStyle = '#cdd6d6';
    ctx.lineWidth = 2.2 * s;
    ctx.beginPath();
    ctx.moveTo(0, deckY);
    ctx.lineTo(0, deckY - mastH);
    ctx.stroke();

    // mainsail (aft of the mast) + jib (forward), gently breathing
    var breathe = 1 + Math.sin(t * 1.6) * 0.03;
    var topY = deckY - mastH * 0.96;
    var footY = deckY - 4 * s;
    sail(
      0,
      topY, // head at masthead
      hullW * 0.4 * breathe,
      footY, // clew aft
      0,
      footY, // tack at mast foot
      lit,
    );
    sail(
      0,
      deckY - mastH * 0.62, // jib head partway up
      -hullW * 0.34 * breathe,
      footY,
      0,
      footY,
      lit,
    );
  }

  // ---------------------------------------------------------------
  // Frame loop
  // ---------------------------------------------------------------
  function frame(time) {
    var t = time / 1000;
    var c = course(t);
    var e = Math.abs(c.err); // spend-swell magnitude
    // forecast warms to red as spending drifts over plan, gone once Dryft trims
    var redAmt = c.correcting ? 0 : clamp01((e - 0.35) / 0.5);
    ctx.clearRect(0, 0, W, H);
    drawSky();
    drawStars(t);
    drawMeteor(t);
    drawGlow();
    drawWater(t, e);
    drawDataLine(t, e, redAmt);
    drawBoat(t, c);

    if (!started) {
      started = true;
      canvas.classList.add('is-ready'); // CSS fades the scene in
    }
  }

  // ---------------------------------------------------------------
  // Lifecycle: only animate when visible & tab is focused.
  // ---------------------------------------------------------------
  var rafId = null;
  var inView = true;
  function loop(time) {
    frame(time);
    rafId = requestAnimationFrame(loop);
  }
  function play() {
    if (rafId == null && inView && !document.hidden) {
      rafId = requestAnimationFrame(loop);
    }
  }
  function stop() {
    if (rafId != null) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
  }

  function init() {
    resize();
    // Paint one frame synchronously so the scene reveals immediately
    // (no flash of the photo fallback waiting on the first rAF, and it
    // still shows in contexts where rAF is throttled, e.g. a hidden tab).
    frame((window.performance && performance.now ? performance.now() : 0) || 0.001);
    if (reduceMotion) return; // static, on-course frame, no loop
    play();
  }

  // Pause when the hero scrolls out of view (saves battery/CPU).
  if ('IntersectionObserver' in window) {
    var io = new IntersectionObserver(
      function (entries) {
        inView = entries[0].isIntersecting;
        if (reduceMotion) return;
        if (inView) play();
        else stop();
      },
      { threshold: 0.01 },
    );
    io.observe(canvas);
  }
  document.addEventListener('visibilitychange', function () {
    if (reduceMotion) return;
    if (document.hidden) stop();
    else play();
  });

  var resizeTimer = null;
  window.addEventListener('resize', function () {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function () {
      resize();
      // repaint after resizing so the canvas is never left blank or stale, even
      // when the loop is paused (hero offscreen / hidden tab); the running loop
      // simply paints its next frame over this one
      frame(reduceMotion ? 0.001 : window.performance && performance.now ? performance.now() : 0);
    }, 150);
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
