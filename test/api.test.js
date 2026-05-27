/**
 * Mocked end-to-end test of /api/waitlist and /api/survey.
 *
 * Run from the project root:
 *   npm test
 *
 * Strategy:
 *   - Mock firebase-admin via require.cache injection (no real creds needed).
 *   - Mock global.fetch in specific tests to exercise reCAPTCHA verification
 *     paths without actually calling Google.
 *   - Build fake req/res objects, invoke the handlers, assert on res + writes.
 *
 * Process exit code is non-zero if any assertion fails — so CI can use it
 * as a gate without parsing stdout.
 */
'use strict';
const path = require('path');
const crypto = require('crypto');

// --- Env vars the handlers expect ---------------------------------------
process.env.FIREBASE_PROJECT_ID = 'mock-project';
process.env.FIREBASE_CLIENT_EMAIL = 'mock@mock.iam.gserviceaccount.com';
process.env.FIREBASE_PRIVATE_KEY =
  '-----BEGIN PRIVATE KEY-----\\nMOCK\\n-----END PRIVATE KEY-----\\n';
process.env.IP_HASH_SALT = 'a'.repeat(64);

// --- Mock firebase-admin --------------------------------------------------
const writes = [];
const mockAdmin = {
  apps: [],
  credential: { cert: () => ({}) },
  initializeApp() {
    mockAdmin.apps.push({});
    return mockAdmin.apps[0];
  },
  firestore() {
    return {
      collection(name) {
        return {
          async add(doc) {
            const id = 'doc_' + crypto.randomBytes(4).toString('hex');
            writes.push({ collection: name, id, doc });
            return { id };
          },
        };
      },
    };
  },
};
mockAdmin.firestore.FieldValue = {
  serverTimestamp: () => '<SERVER_TIMESTAMP>',
};

// Inject into require.cache BEFORE the handlers are loaded.
// Path is computed from __dirname so the test works regardless of where
// the repo is checked out (CI runners, contributors' machines, etc.).
const projectRoot = path.resolve(__dirname, '..');
const adminPath = require.resolve('firebase-admin', {
  paths: [path.join(projectRoot, 'api', '_lib')],
});
require.cache[adminPath] = {
  id: adminPath,
  filename: adminPath,
  loaded: true,
  exports: mockAdmin,
  children: [],
  paths: [],
};

// Now load the handlers
const waitlist = require(path.join(projectRoot, 'api', 'waitlist.js'));
const survey = require(path.join(projectRoot, 'api', 'survey.js'));

// --- Test harness ---------------------------------------------------------
let pass = 0,
  fail = 0;
const failures = [];

function ok(cond, label, detail) {
  if (cond) {
    pass++;
    console.log('  \x1b[32m✓\x1b[0m ' + label);
  } else {
    fail++;
    failures.push({ label, detail });
    console.log('  \x1b[31m✗\x1b[0m ' + label + (detail ? '\n      ' + detail : ''));
  }
}

// Build a fake (req, res) pair.
//
// `body` can be:
//   - an object → encoded as JSON (matches what the site sends)
//   - a Buffer  → sent raw (lets us test x-www-form-urlencoded + oversize)
// Test-unique IPs by default so the rate limiter doesn't bleed counters
// across independent tests. Override by passing opts.ip explicitly when
// you want to exercise rate-limit behavior with a known repeating IP.
let _ipCounter = 1;
function fakeReqRes(method, body, opts = {}) {
  const ip = opts.ip || '203.0.113.' + _ipCounter++;
  const headers = Object.assign(
    {
      'user-agent': 'Mozilla/5.0 TestRunner',
      'x-forwarded-for': ip,
    },
    opts.headers || {},
  );

  let payloadBuffer;
  if (Buffer.isBuffer(body)) {
    payloadBuffer = body;
    headers['content-type'] = opts.contentType || 'application/x-www-form-urlencoded';
  } else if (body != null) {
    payloadBuffer = Buffer.from(JSON.stringify(body));
    headers['content-type'] = 'application/json';
  }

  // Async iterator yielding the body buffer in one chunk — matches how
  // readBody() in validate.js consumes the request stream.
  const req = {
    method,
    headers,
    socket: { remoteAddress: '127.0.0.1' },
    body: undefined, // force readBody to stream-parse
    [Symbol.asyncIterator]() {
      let yielded = false;
      return {
        next() {
          if (yielded || !payloadBuffer) return Promise.resolve({ value: undefined, done: true });
          yielded = true;
          return Promise.resolve({ value: payloadBuffer, done: false });
        },
      };
    },
  };

  const res = {
    statusCode: 200,
    body: null,
    headers: {},
    status(c) {
      this.statusCode = c;
      return this;
    },
    setHeader(k, v) {
      this.headers[k.toLowerCase()] = v;
    },
    json(obj) {
      this.body = obj;
      return this;
    },
  };

  return { req, res };
}

async function run() {
  console.log('\n\x1b[1m== /api/waitlist ==\x1b[0m');

  // -- Happy path
  {
    writes.length = 0;
    const { req, res } = fakeReqRes('POST', {
      email: 'jane@example.com',
      source: 'hero',
      dwell_ms: 4321,
    });
    await waitlist(req, res);
    ok(
      res.statusCode === 200,
      'returns 200 on valid submit',
      'got ' + res.statusCode + ' ' + JSON.stringify(res.body),
    );
    ok(
      res.body && res.body.ok === true && typeof res.body.id === 'string',
      'response has ok:true + id',
    );
    ok(
      writes.length === 1 && writes[0].collection === 'waitlist',
      'wrote 1 doc to waitlist collection',
    );
    const w = writes[0]?.doc || {};
    ok(w.email === 'jane@example.com', 'email stored verbatim');
    ok(w.emailLower === 'jane@example.com', 'emailLower stored for dedup');
    ok(w.source === 'hero', 'source stored');
    ok(w.dwellMs === 4321, 'dwellMs parsed to integer');
    ok(typeof w.ipHash === 'string' && w.ipHash.length === 16, 'ipHash present, 16 hex chars');
    ok(w.ipHash !== '203.0.113.42', 'ipHash is hashed, not plaintext IP');
    ok(w.userAgent === 'Mozilla/5.0 TestRunner', 'userAgent stored');
    ok(w.createdAt === '<SERVER_TIMESTAMP>', 'createdAt set to server timestamp sentinel');
  }

  // -- Method check
  {
    const { req, res } = fakeReqRes('GET');
    await waitlist(req, res);
    ok(res.statusCode === 405, 'GET → 405');
    ok(res.headers.allow === 'POST', 'Allow header set on 405');
  }

  // -- Bad email
  {
    writes.length = 0;
    const { req, res } = fakeReqRes('POST', { email: 'not-an-email', source: 'hero' });
    await waitlist(req, res);
    ok(
      res.statusCode === 400 && res.body.reason === 'email',
      'rejects malformed email with reason:email',
    );
    ok(writes.length === 0, 'nothing written when email is bad');
  }

  // -- Bad source
  {
    writes.length = 0;
    const { req, res } = fakeReqRes('POST', { email: 'a@b.co', source: 'evil; DROP TABLE' });
    await waitlist(req, res);
    ok(
      res.statusCode === 400 && res.body.reason === 'source',
      'rejects invalid source with reason:source',
    );
  }

  // -- Email sanitization: behavior is "strip non-whitelisted chars, THEN
  // validate the result". For `Jane@Example.com<script>`, the brackets are
  // stripped (not in the whitelist) but `script` survives — so the stored
  // email becomes `Jane@Example.comscript`, which still passes the email
  // regex (the TLD `comscript` looks valid). This is permissive-but-safe
  // because we never echo the value as HTML; worst case is garbage in the
  // DB row, not code execution. Documented here so future-me doesn't get
  // confused.
  {
    writes.length = 0;
    const { req, res } = fakeReqRes('POST', {
      email: '  Jane@Example.com<script>  ',
      source: 'final',
    });
    await waitlist(req, res);
    ok(res.statusCode === 200, 'sanitizable email accepted (with caveat below)');
    ok(
      writes[0]?.doc.email === 'Jane@Example.comscript',
      'angle brackets stripped; alphanumerics in the attack survive',
    );
    ok(
      writes[0]?.doc.emailLower === 'jane@example.comscript',
      'emailLower lowercases the sanitized form',
    );
  }

  // -- Email that is unsalvageable gets rejected
  {
    writes.length = 0;
    const { req, res } = fakeReqRes('POST', { email: '!!!@!!!', source: 'hero' });
    await waitlist(req, res);
    ok(
      res.statusCode === 400 && res.body.reason === 'email',
      'no-alphanumerics email → rejected by validator',
    );
  }

  // -- Oversize body
  {
    writes.length = 0;
    const huge = Buffer.alloc(20 * 1024, 0x61); // 20 KB of 'a'
    const { req, res } = fakeReqRes('POST', huge, {
      contentType: 'application/x-www-form-urlencoded',
    });
    await waitlist(req, res);
    ok(res.statusCode === 413, '20 KB body → 413 payload too large');
    ok(writes.length === 0, 'nothing written when body is too large');
  }

  // -- x-www-form-urlencoded compatibility (matches Apps Script style)
  {
    writes.length = 0;
    const body = Buffer.from('email=urlenc%40example.com&source=hero&dwell_ms=2000');
    const { req, res } = fakeReqRes('POST', body, {
      contentType: 'application/x-www-form-urlencoded',
    });
    await waitlist(req, res);
    ok(res.statusCode === 200, 'urlencoded body accepted');
    ok(writes[0]?.doc.email === 'urlenc@example.com', 'urlencoded email decoded');
  }

  console.log('\n\x1b[1m== /api/survey ==\x1b[0m');

  // -- Happy path: full valid survey
  {
    writes.length = 0;
    const payload = {
      email: 'mid@example.com',
      source: 'final',
      careerStage: 'Mid-career professional',
      lifeStage: 'Living independently',
      q1: '5',
      q2: '4',
      q3: '3',
      q4: '2',
      q5: '1',
      q6: '4',
      q8: '5',
      q9: '3',
      q10: '4',
      q11: '5',
      q7: 'Yes',
      q12: 'Subscriptions sneak up on me each month.',
    };
    const { req, res } = fakeReqRes('POST', payload);
    await survey(req, res);
    ok(res.statusCode === 200, 'full valid survey → 200');
    ok(
      writes.length === 1 && writes[0].collection === 'survey',
      'wrote 1 doc to survey collection',
    );
    const d = writes[0]?.doc || {};
    ok(d.careerStage === 'Mid-career professional', 'careerStage allowlist accepts known value');
    ok(d.lifeStage === 'Living independently', 'lifeStage allowlist accepts known value');
    ok(d.q1 === 5 && d.q11 === 5, 'Likert stored as integer, not string');
    ok(d.q7 === 'Yes', 'q7 Yes/No stored');
    ok(d.q12 === 'Subscriptions sneak up on me each month.', 'q12 free text stored');
  }

  // -- Required field validation
  {
    writes.length = 0;
    const { req, res } = fakeReqRes('POST', {
      email: 'a@b.co',
      source: 'hero' /* no careerStage */,
    });
    await survey(req, res);
    ok(
      res.statusCode === 400 && res.body.reason === 'careerStage',
      'missing careerStage → 400 reason:careerStage',
    );
  }

  // -- Missing lifeStage rejected (separately from careerStage)
  {
    writes.length = 0;
    const { req, res } = fakeReqRes('POST', {
      email: 'a@b.co',
      source: 'hero',
      careerStage: 'Retired',
    });
    await survey(req, res);
    ok(
      res.statusCode === 400 && res.body.reason === 'lifeStage',
      'missing lifeStage → 400 reason:lifeStage',
    );
  }

  // -- Stage allowlist rejects junk
  {
    writes.length = 0;
    const { req, res } = fakeReqRes('POST', {
      email: 'a@b.co',
      source: 'hero',
      careerStage: 'Astronaut',
      lifeStage: 'Living independently',
    });
    await survey(req, res);
    ok(
      res.statusCode === 400 && res.body.reason === 'careerStage',
      'unknown careerStage rejected (allowlist enforced)',
    );
  }

  // -- Missing Likert answers stored as null (stable doc shape)
  {
    writes.length = 0;
    const { req, res } = fakeReqRes('POST', {
      email: 'sparse@example.com',
      source: 'hero',
      careerStage: 'Retired',
      lifeStage: 'Retired',
      q1: '4', // only q1, others missing
    });
    await survey(req, res);
    ok(res.statusCode === 200, 'sparse survey accepted (Likert is optional per question)');
    const d = writes[0]?.doc || {};
    ok(d.q1 === 4, 'q1 stored as integer 4');
    ok(d.q5 === null && d.q11 === null, 'missing Likert answers stored as null');
  }

  // -- Out-of-range Likert sanitized to null
  {
    writes.length = 0;
    const { req, res } = fakeReqRes('POST', {
      email: 'oof@example.com',
      source: 'hero',
      careerStage: 'Retired',
      lifeStage: 'Retired',
      q1: '7',
      q2: 'haha',
      q3: '-1',
    });
    await survey(req, res);
    const d = writes[0]?.doc || {};
    ok(
      d.q1 === null && d.q2 === null && d.q3 === null,
      'out-of-range / non-numeric Likert → null (not stored as junk)',
    );
  }

  // -- q7 Yes/No allowlist
  {
    writes.length = 0;
    const { req, res } = fakeReqRes('POST', {
      email: 'yn@example.com',
      source: 'hero',
      careerStage: 'Retired',
      lifeStage: 'Retired',
      q7: 'Maybe',
    });
    await survey(req, res);
    ok(writes[0]?.doc.q7 === '', 'q7 outside Yes/No allowlist → empty string');
  }

  // -- q12 formula injection defused
  {
    writes.length = 0;
    const { req, res } = fakeReqRes('POST', {
      email: 'inj@example.com',
      source: 'hero',
      careerStage: 'Retired',
      lifeStage: 'Retired',
      q12: '=HYPERLINK("https://evil.com","Click me")',
    });
    await survey(req, res);
    const got = writes[0]?.doc.q12;
    ok(got.startsWith("'="), 'q12 formula injection: leading = prefixed with apostrophe');
  }

  // -- q12 control char strip + length cap
  {
    writes.length = 0;
    const bigText = 'A'.repeat(3000) + '\x00 nullbyte';
    const { req, res } = fakeReqRes('POST', {
      email: 'big@example.com',
      source: 'hero',
      careerStage: 'Retired',
      lifeStage: 'Retired',
      q12: bigText,
    });
    await survey(req, res);
    const got = writes[0]?.doc.q12;
    ok(got.length === 2000, 'q12 capped at 2000 chars');
    ok(!got.includes('\x00'), 'q12 null byte stripped');
  }

  // -- IP hashing stability — explicit same IP across two requests
  {
    writes.length = 0;
    const { req: r1, res: w1 } = fakeReqRes(
      'POST',
      { email: 'a@b.co', source: 'hero' },
      { ip: '198.51.100.7' },
    );
    const { req: r2, res: w2 } = fakeReqRes(
      'POST',
      { email: 'c@d.co', source: 'hero' },
      { ip: '198.51.100.7' },
    );
    await waitlist(r1, w1);
    await waitlist(r2, w2);
    ok(writes[0].doc.ipHash === writes[1].doc.ipHash, 'same IP → same ipHash (correlation works)');
  }

  // -- IP hashing salt missing → null (no insecure fallback)
  {
    const saved = process.env.IP_HASH_SALT;
    delete process.env.IP_HASH_SALT;
    writes.length = 0;
    const { req, res } = fakeReqRes('POST', { email: 'a@b.co', source: 'hero' });
    await waitlist(req, res);
    ok(writes[0]?.doc.ipHash === null, 'missing salt → ipHash is null (fails closed, not open)');
    process.env.IP_HASH_SALT = saved;
  }

  console.log('\n\x1b[1m== App Check (reCAPTCHA v3) ==\x1b[0m');

  // -- Without secret: verification is skipped (back-compat / staging)
  {
    delete process.env.RECAPTCHA_SECRET_KEY;
    writes.length = 0;
    const { req, res } = fakeReqRes('POST', { email: 'norecaptcha@example.com', source: 'hero' });
    await waitlist(req, res);
    ok(res.statusCode === 200, 'no RECAPTCHA_SECRET_KEY → verification skipped, request accepted');
  }

  // -- With secret + missing token: rejected
  {
    process.env.RECAPTCHA_SECRET_KEY = 'TEST_SECRET';
    // Stub global fetch so we don't actually call Google
    const origFetch = global.fetch;
    global.fetch = () =>
      Promise.resolve({ json: () => Promise.resolve({ success: true, score: 0.9 }) });

    writes.length = 0;
    const { req, res } = fakeReqRes('POST', {
      email: 'notok@example.com',
      source: 'hero' /* no recaptchaToken */,
    });
    await waitlist(req, res);
    ok(
      res.statusCode === 403 && res.body.reason === 'recaptcha:missing-token',
      'secret set + no token → 403 recaptcha:missing-token',
    );

    global.fetch = origFetch;
  }

  // -- With secret + valid token (score ≥ 0.5): accepted
  {
    process.env.RECAPTCHA_SECRET_KEY = 'TEST_SECRET';
    const origFetch = global.fetch;
    global.fetch = () =>
      Promise.resolve({ json: () => Promise.resolve({ success: true, score: 0.9 }) });

    writes.length = 0;
    const { req, res } = fakeReqRes('POST', {
      email: 'human@example.com',
      source: 'hero',
      recaptchaToken: 'tok_human',
    });
    await waitlist(req, res);
    ok(res.statusCode === 200, 'valid token + high score (0.9) → accepted');

    global.fetch = origFetch;
  }

  // -- With secret + low score (< 0.5): rejected
  {
    process.env.RECAPTCHA_SECRET_KEY = 'TEST_SECRET';
    const origFetch = global.fetch;
    global.fetch = () =>
      Promise.resolve({ json: () => Promise.resolve({ success: true, score: 0.2 }) });

    writes.length = 0;
    const { req, res } = fakeReqRes('POST', {
      email: 'bot@example.com',
      source: 'hero',
      recaptchaToken: 'tok_bot',
    });
    await waitlist(req, res);
    ok(
      res.statusCode === 403 && res.body.reason === 'recaptcha:low-score',
      'low score (0.2) → 403 recaptcha:low-score',
    );

    global.fetch = origFetch;
  }

  // -- Google unreachable: fail OPEN (better than losing real signups)
  {
    process.env.RECAPTCHA_SECRET_KEY = 'TEST_SECRET';
    const origFetch = global.fetch;
    global.fetch = () => Promise.reject(new Error('network down'));

    writes.length = 0;
    const { req, res } = fakeReqRes('POST', {
      email: 'degraded@example.com',
      source: 'hero',
      recaptchaToken: 'tok',
    });
    await waitlist(req, res);
    ok(res.statusCode === 200, 'Google verify unreachable → fail open (rate limit still applies)');

    global.fetch = origFetch;
    delete process.env.RECAPTCHA_SECRET_KEY;
  }

  console.log('\n\x1b[1m== Rate limiting ==\x1b[0m');

  // -- In-memory rate limit: 5 waitlist submits in 60s → 6th blocked
  //    (Upstash isn't configured in the test env, so in-memory path runs.)
  //    Pin to one IP so all 7 hits hit the same bucket.
  const burstIp = '192.0.2.99';
  {
    writes.length = 0;
    const statuses = [];
    for (let i = 0; i < 7; i++) {
      const { req, res } = fakeReqRes(
        'POST',
        { email: 'burst' + i + '@example.com', source: 'hero' },
        { ip: burstIp },
      );
      await waitlist(req, res);
      statuses.push(res.statusCode);
    }
    const ok200 = statuses.filter((s) => s === 200).length;
    const ok429 = statuses.filter((s) => s === 429).length;
    ok(ok200 === 5, '5 submits in burst → first 5 accepted (got ' + ok200 + ')');
    ok(ok429 === 2, '6th and 7th submits → 429 rate-limited (got ' + ok429 + ')');
  }

  // -- 429 response carries Retry-After header (same IP, still over limit)
  {
    const { req, res } = fakeReqRes(
      'POST',
      { email: 'still-over@example.com', source: 'hero' },
      { ip: burstIp },
    );
    await waitlist(req, res);
    ok(res.statusCode === 429, 'still rate-limited within the window');
    ok(
      typeof res.headers['retry-after'] === 'string' && parseInt(res.headers['retry-after']) > 0,
      'Retry-After header set on 429',
    );
  }

  // -- Survey has its own bucket (separate from waitlist), even from the same IP
  {
    const { req, res } = fakeReqRes(
      'POST',
      {
        email: 'separate@example.com',
        source: 'hero',
        careerStage: 'Retired',
        lifeStage: 'Retired',
      },
      { ip: burstIp },
    );
    await survey(req, res);
    ok(res.statusCode === 200, 'survey bucket is independent of waitlist bucket');
  }

  // -- Done
  console.log('\n' + '─'.repeat(40));
  console.log(`\x1b[1m${pass} passed, ${fail} failed\x1b[0m`);
  if (fail > 0) process.exit(1);
}

run().catch((err) => {
  console.error('\nHarness crashed:', err);
  process.exit(2);
});
