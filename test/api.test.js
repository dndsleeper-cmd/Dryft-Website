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
 * Process exit code is non-zero if any assertion fails, so CI can use it
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
// Keyed doc store ("<collection>/<id>" → data) so we can exercise the
// upsert/merge path used by progressive survey autosave.
const docStore = new Map();
// Resolve FieldValue.increment(n) sentinels against the previous doc value, so
// the mock mirrors Firestore's atomic numeric increment (used for referral
// credit: priorityScore += 10, referralCount += 1).
function resolveIncrements(prev, doc) {
  const out = {};
  for (const k of Object.keys(doc)) {
    const v = doc[k];
    if (v && typeof v === 'object' && typeof v.__increment === 'number') {
      out[k] = (typeof prev[k] === 'number' ? prev[k] : 0) + v.__increment;
    } else {
      out[k] = v;
    }
  }
  return out;
}

function makeDocRef(name, id) {
  const key = name + '/' + id;
  return {
    id,
    async get() {
      const existing = docStore.get(key);
      return { exists: docStore.has(key), id, data: () => existing };
    },
    async set(doc, opts) {
      const prev = docStore.get(key) || {};
      const resolved = resolveIncrements(prev, doc);
      const merged = opts && opts.merge ? { ...prev, ...resolved } : { ...resolved };
      docStore.set(key, merged);
      writes.push({ collection: name, id, doc: merged, op: 'set', merge: !!(opts && opts.merge) });
      return;
    },
  };
}

function makeCollection(name) {
  return {
    async add(doc) {
      const id = 'doc_' + crypto.randomBytes(4).toString('hex');
      writes.push({ collection: name, id, doc });
      docStore.set(name + '/' + id, { ...doc });
      return { id };
    },
    doc(id) {
      return makeDocRef(name, id);
    },
    // Bare collection count (totalCount), counts every doc in the collection.
    count() {
      return {
        async get() {
          let count = 0;
          for (const k of docStore.keys()) if (k.startsWith(name + '/')) count++;
          return { data: () => ({ count }) };
        },
      };
    },
    // Minimal where().count().get(), only the '>' operator the API uses.
    where(field, op, val) {
      return {
        count() {
          return {
            async get() {
              let count = 0;
              for (const [k, v] of docStore) {
                if (!k.startsWith(name + '/')) continue;
                const fv = v[field];
                if (typeof fv !== 'number') continue;
                if (op === '>' ? fv > val : fv === val) count++;
              }
              return { data: () => ({ count }) };
            },
          };
        },
      };
    },
  };
}

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
        return makeCollection(name);
      },
      // Reads and writes are synchronous against docStore in this mock, so a
      // transaction is just the callback invoked with get/set proxies to refs.
      async runTransaction(fn) {
        const tx = {
          get: (ref) => ref.get(),
          set: (ref, doc, opts) => ref.set(doc, opts),
          update: (ref, doc) => ref.set(doc, { merge: true }),
          create: (ref, doc) => ref.set(doc, { merge: false }),
        };
        return fn(tx);
      },
    };
  },
};
mockAdmin.firestore.FieldValue = {
  serverTimestamp: () => '<SERVER_TIMESTAMP>',
  increment: (n) => ({ __increment: n }),
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
const lookup = require(path.join(projectRoot, 'api', 'lookup.js'));
const stats = require(path.join(projectRoot, 'api', 'stats.js'));
// Pull the real helpers so tests assert against the actual implementations.
const { phoneDocId, makeReferralCode, sanitizeReferralCode, priorityScore } = require(
  path.join(projectRoot, 'api', '_lib', 'validate.js'),
);

// Deterministic, distinct, VALID NANP numbers keyed by a human-readable label,
// so "same person" tests reuse one number. Format: +1 416 555 XXXX (area 416,
// exchange 555, sequential 4-digit line). Re-asking for a label returns the
// same E.164 string.
const _phoneMap = new Map();
let _phoneSeq = 0;
function phoneFor(label) {
  if (!_phoneMap.has(label)) {
    _phoneSeq++;
    _phoneMap.set(label, '+1416555' + String(_phoneSeq).padStart(4, '0'));
  }
  return _phoneMap.get(label);
}

// --- Test harness ---------------------------------------------------------
let pass = 0,
  fail = 0;
const failures = [];

// A single waitlist signup now also writes the seq counter (meta/counters) and
// the code→owner mapping (referralCodes/<CODE>), so filter to the waitlist
// collection when asserting on the user doc / counting signups.
const wlWrites = () => writes.filter((w) => w.collection === 'waitlist');

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

  // Async iterator yielding the body buffer in one chunk, matches how
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
      phone: phoneFor('jane'),
      region: 'CA',
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
      wlWrites().length === 1 && wlWrites()[0].collection === 'waitlist',
      'wrote 1 doc to waitlist collection',
    );
    const w = wlWrites()[0]?.doc || {};
    ok(w.phone === phoneFor('jane'), 'phone stored verbatim (E.164)');
    ok(w.region === 'CA', 'region stored');
    ok(w.source === 'hero', 'source stored');
    ok(w.dwellMs === 4321, 'dwellMs parsed to integer');
    ok(typeof w.ipHash === 'string' && w.ipHash.length === 16, 'ipHash present, 16 hex chars');
    ok(w.ipHash !== '203.0.113.42', 'ipHash is hashed, not plaintext IP');
    ok(w.userAgent === 'Mozilla/5.0 TestRunner', 'userAgent stored');
    ok(w.createdAt === '<SERVER_TIMESTAMP>', 'createdAt set to server timestamp sentinel');
    // New ranking + referral fields on first signup.
    ok(w.seq === 1, 'first signup gets seq 1');
    ok(
      typeof w.referralCode === 'string' && w.referralCode.length === 7,
      'referralCode generated (7 chars)',
    );
    ok(w.referralCount === 0, 'referralCount starts at 0');
    ok(w.surveyComplete === false, 'surveyComplete starts false');
    ok(w.priorityScore === -1, 'priorityScore = -seq for a fresh non-completer (-1)');
    ok(res.body.referralCode === w.referralCode, 'response echoes referralCode');
    ok(res.body.position === 1, 'first signup is position #1');
  }

  // -- Dedup: re-signing up with the SAME number updates one doc (no duplicate)
  {
    writes.length = 0;
    const phone = phoneFor('repeat');
    const digits = phone.slice(2); // strip "+1"
    const pretty = '+1 (' + digits.slice(0, 3) + ') ' + digits.slice(3, 6) + '-' + digits.slice(6);
    const { req: r1, res: w1 } = fakeReqRes('POST', { phone, source: 'hero' });
    await waitlist(r1, w1);
    const { req: r2, res: w2 } = fakeReqRes('POST', {
      phone: pretty, // same number, with punctuation/spaces
      source: 'final',
    });
    await waitlist(r2, w2);
    const ids = new Set(wlWrites().map((wr) => wr.id));
    ok(
      ids.size === 1 && ids.has(phoneDocId(phone)),
      'same number → one waitlist doc (punctuation-insensitive)',
    );
    const d = docStore.get('waitlist/' + phoneDocId(phone)) || {};
    ok(d.signupCount === 2, 'signupCount increments on re-signup instead of duplicating');
    ok(d.source === 'final', 'latest source recorded');
  }

  // -- Method check
  {
    const { req, res } = fakeReqRes('GET');
    await waitlist(req, res);
    ok(res.statusCode === 405, 'GET → 405');
    ok(res.headers.allow === 'POST', 'Allow header set on 405');
  }

  // -- Bad phone
  {
    writes.length = 0;
    const { req, res } = fakeReqRes('POST', { phone: '12345', source: 'hero' });
    await waitlist(req, res);
    ok(
      res.statusCode === 400 && res.body.reason === 'phone',
      'rejects malformed phone with reason:phone',
    );
    ok(writes.length === 0, 'nothing written when phone is bad');
  }

  // -- Bad source
  {
    writes.length = 0;
    const { req, res } = fakeReqRes('POST', { phone: phoneFor('src'), source: 'evil; DROP TABLE' });
    await waitlist(req, res);
    ok(
      res.statusCode === 400 && res.body.reason === 'source',
      'rejects invalid source with reason:source',
    );
  }

  // -- Phone normalization: punctuation/spaces and a leading country code are
  // stripped, and a bare 10-digit NANP number is assumed +1. All three forms
  // below normalize to the same stored E.164 string.
  {
    writes.length = 0;
    const { req, res } = fakeReqRes('POST', {
      phone: '  +1 (416) 555-9001  ',
      source: 'final',
    });
    await waitlist(req, res);
    ok(res.statusCode === 200, 'punctuated number accepted');
    ok(
      wlWrites()[0]?.doc.phone === '+14165559001',
      'punctuation/spaces stripped → canonical E.164',
    );
  }

  // -- Bare 10-digit number (no country code) → assumed +1
  {
    writes.length = 0;
    const { req, res } = fakeReqRes('POST', { phone: '4165559002', source: 'hero' });
    await waitlist(req, res);
    ok(res.statusCode === 200, 'bare 10-digit NANP number accepted');
    ok(wlWrites()[0]?.doc.phone === '+14165559002', 'bare number normalized to +1…');
  }

  // -- Phone that can't be salvaged (invalid NANP area/exchange) is rejected
  {
    writes.length = 0;
    const { req, res } = fakeReqRes('POST', { phone: '+11115559003', source: 'hero' });
    await waitlist(req, res);
    ok(
      res.statusCode === 400 && res.body.reason === 'phone',
      'invalid NANP area code (starts with 1) → rejected by validator',
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
    const body = Buffer.from('phone=%2B14165559004&source=hero&dwell_ms=2000');
    const { req, res } = fakeReqRes('POST', body, {
      contentType: 'application/x-www-form-urlencoded',
    });
    await waitlist(req, res);
    ok(res.statusCode === 200, 'urlencoded body accepted');
    ok(wlWrites()[0]?.doc.phone === '+14165559004', 'urlencoded phone decoded');
  }

  console.log('\n\x1b[1m== Referral helpers (unit) ==\x1b[0m');

  {
    const CROCKFORD = /^[0-9ABCDEFGHJKMNPQRSTVWXYZ]+$/;
    const c1 = makeReferralCode('+14165551234');
    ok(c1.length === 7 && CROCKFORD.test(c1), 'makeReferralCode → 7 Crockford chars');
    ok(makeReferralCode('+14165551234') === c1, 'makeReferralCode is deterministic');
    ok(
      sanitizeReferralCode(' ' + c1.toLowerCase() + ' ') === c1,
      'sanitizeReferralCode round-trips a real code',
    );
    ok(sanitizeReferralCode('o0i1L') === '00111', 'sanitizeReferralCode folds O→0, I/L→1');
    ok(sanitizeReferralCode('!!') === '', 'sanitizeReferralCode rejects too-short junk');
    ok(
      priorityScore({ surveyComplete: false, seq: 5, referralCount: 0 }) === -5,
      'score = -seq for fresh non-completer',
    );
    ok(
      priorityScore({ surveyComplete: false, seq: 5, referralCount: 2 }) === 15,
      'each referral adds +10 (-5 + 20 = 15)',
    );
    ok(
      priorityScore({ surveyComplete: false, seq: 5, referralCount: 0, usedReferral: true }) === 0,
      'using a code adds +5 (-5 + 5 = 0)',
    );
    ok(
      priorityScore({ surveyComplete: true, seq: 5, referralCount: 0 }) === 1e9 - 5,
      'survey completion adds the +1e9 tier',
    );
  }

  console.log('\n\x1b[1m== Referral flow (/api/waitlist) ==\x1b[0m');

  // -- New signup returns a code + position and writes the code→owner mapping
  {
    writes.length = 0;
    const { req, res } = fakeReqRes('POST', { phone: phoneFor('refA'), source: 'hero' });
    await waitlist(req, res);
    const code = res.body.referralCode;
    ok(typeof code === 'string' && code.length === 7, 'returns a 7-char referralCode');
    ok(
      typeof res.body.position === 'number' && res.body.position >= 1,
      'returns a numeric position',
    );
    const map = docStore.get('referralCodes/' + code) || {};
    ok(map.ownerId === phoneDocId(phoneFor('refA')), 'code→owner mapping doc written');
  }

  // -- Referrer gets +1 referral and +10 priority when someone uses their code
  {
    const aId = phoneDocId(phoneFor('refA'));
    const aBefore = docStore.get('waitlist/' + aId) || {};
    const codeA = aBefore.referralCode;
    const scoreABefore = aBefore.priorityScore;
    const refCountBefore = aBefore.referralCount || 0;

    writes.length = 0;
    const { req, res } = fakeReqRes('POST', {
      phone: phoneFor('refB'),
      source: 'referral',
      referredByCode: codeA,
    });
    await waitlist(req, res);
    const aAfter = docStore.get('waitlist/' + aId) || {};
    const bDoc = docStore.get('waitlist/' + phoneDocId(phoneFor('refB'))) || {};
    ok(aAfter.referralCount === refCountBefore + 1, 'referrer referralCount += 1');
    ok(
      aAfter.priorityScore === scoreABefore + 10,
      'referrer priorityScore += 10 (moves up 10 spots)',
    );
    ok(bDoc.referredByCode === codeA, 'referred signup records referredByCode');
    ok(bDoc.usedReferral === true, 'referred signup is flagged usedReferral');
    ok(bDoc.priorityScore === -bDoc.seq + 5, 'referred signup gets +5 (joined with a code)');
    ok(
      res.statusCode === 200 && typeof res.body.position === 'number',
      'referred signup succeeds with a position',
    );
  }

  // -- Self-referral with one's own code is ignored (no credit)
  {
    const phone = phoneFor('selfref');
    const ownCode = makeReferralCode(phone);
    writes.length = 0;
    const { req, res } = fakeReqRes('POST', { phone, source: 'referral', referredByCode: ownCode });
    await waitlist(req, res);
    const d = docStore.get('waitlist/' + phoneDocId(phone)) || {};
    ok(d.referralCount === 0, 'self-referral grants no credit');
    ok(!('referredByCode' in d), 'self-referral does not set referredByCode');
  }

  // -- Re-submitting with a code never re-credits the referrer
  {
    const aId = phoneDocId(phoneFor('refA'));
    const codeA = (docStore.get('waitlist/' + aId) || {}).referralCode;
    const countBefore = (docStore.get('waitlist/' + aId) || {}).referralCount;
    // refB re-submits, again citing A's code.
    const { req, res } = fakeReqRes('POST', {
      phone: phoneFor('refB'),
      source: 'referral',
      referredByCode: codeA,
    });
    await waitlist(req, res);
    const aAfter = docStore.get('waitlist/' + aId) || {};
    ok(aAfter.referralCount === countBefore, 're-submit with a code does not double-credit');
  }

  // -- An ALREADY-SIGNED-UP member cannot self-bump by applying a code later.
  //    refC joins first with NO code, then re-submits citing A's code. The code
  //    must not retroactively grant refC the +5 "joined via referral" bonus, must
  //    not stamp referredByCode, and must not credit the code owner (A).
  {
    const cPhone = phoneFor('refC');
    const cId = phoneDocId(cPhone);
    const aId = phoneDocId(phoneFor('refA'));
    const codeA = (docStore.get('waitlist/' + aId) || {}).referralCode;

    // First signup, plain join, no code.
    const { req: r1, res: w1 } = fakeReqRes('POST', { phone: cPhone, source: 'final' });
    await waitlist(r1, w1);
    const cFirst = docStore.get('waitlist/' + cId) || {};
    const aCountBefore = (docStore.get('waitlist/' + aId) || {}).referralCount;
    ok(cFirst.usedReferral === false, 'plain first signup is not flagged usedReferral');

    // Second submit, now tries to ride someone else's code.
    const { req: r2, res: w2 } = fakeReqRes('POST', {
      phone: cPhone,
      source: 'referral',
      referredByCode: codeA,
    });
    await waitlist(r2, w2);
    const cAfter = docStore.get('waitlist/' + cId) || {};
    const aAfter = docStore.get('waitlist/' + aId) || {};
    ok(
      cAfter.usedReferral === false,
      'existing member gets no usedReferral bonus from a later code',
    );
    ok(
      cAfter.priorityScore === cFirst.priorityScore,
      "existing member's score is unchanged by a later code",
    );
    ok(
      !('referredByCode' in cAfter),
      'existing member cannot acquire referredByCode after first signup',
    );
    ok(
      aAfter.referralCount === aCountBefore,
      'code owner is not credited by an existing member re-submitting',
    );
  }

  console.log('\n\x1b[1m== /api/lookup ==\x1b[0m');

  // -- Look up an existing member's code + position by phone
  {
    // refA was signed up earlier in the referral flow section.
    const { req, res } = fakeReqRes('POST', { phone: phoneFor('refA') });
    await lookup(req, res);
    const expectedCode = (docStore.get('waitlist/' + phoneDocId(phoneFor('refA'))) || {})
      .referralCode;
    ok(res.statusCode === 200 && res.body.found === true, 'known number → found:true');
    ok(res.body.referralCode === expectedCode, 'returns the stored referral code');
    ok(
      typeof res.body.position === 'number' && res.body.position >= 1,
      'returns a numeric position',
    );
  }

  // -- Unknown number → found:false (no doc created)
  {
    writes.length = 0;
    const { req, res } = fakeReqRes('POST', { phone: phoneFor('nobody-here') });
    await lookup(req, res);
    ok(res.statusCode === 200 && res.body.found === false, 'unknown number → found:false');
    ok(writes.length === 0, 'lookup never writes anything');
  }

  // -- Bad phone rejected; wrong method rejected
  {
    const { req, res } = fakeReqRes('POST', { phone: '12345' });
    await lookup(req, res);
    ok(res.statusCode === 400 && res.body.reason === 'phone', 'malformed number → 400');
    const { req: r2, res: w2 } = fakeReqRes('GET');
    await lookup(r2, w2);
    ok(w2.statusCode === 405, 'GET → 405');
  }

  console.log('\n\x1b[1m== /api/stats ==\x1b[0m');

  // -- Total count for the "Join N others" social-proof line
  {
    const { req, res } = fakeReqRes('GET');
    await stats(req, res);
    ok(res.statusCode === 200 && res.body.ok === true, 'GET stats → 200 ok');
    ok(typeof res.body.count === 'number' && res.body.count >= 1, 'returns a numeric total count');
    const { req: r2, res: w2 } = fakeReqRes('POST', { phone: phoneFor('x') });
    await stats(r2, w2);
    ok(w2.statusCode === 405, 'POST → 405 (stats is GET-only)');
  }

  console.log('\n\x1b[1m== /api/survey ==\x1b[0m');

  // -- Happy path: full valid survey
  {
    writes.length = 0;
    const payload = {
      phone: phoneFor('mid'),
      source: 'final',
      careerStage: 'Mid-career (4-10yrs)',
      lifeStage: 'Living alone',
      q1: '5',
      q2: '4',
      q3: '3',
      q4: '2',
      q5: '1',
      q6: '4',
      q7: '5',
      q8: 'Yes',
      q9: 'Subscriptions sneak up on me each month.',
    };
    const { req, res } = fakeReqRes('POST', payload);
    await survey(req, res);
    ok(res.statusCode === 200, 'full valid survey → 200');
    ok(
      writes.length === 1 && writes[0].collection === 'survey',
      'wrote 1 doc to survey collection',
    );
    const d = writes[0]?.doc || {};
    ok(d.careerStage === 'Mid-career (4-10yrs)', 'careerStage allowlist accepts known value');
    ok(d.lifeStage === 'Living alone', 'lifeStage allowlist accepts known value');
    ok(d.q1 === 5 && d.q7 === 5, 'Likert stored as integer, not string');
    ok(d.q8 === 'Yes', 'q8 Yes/No stored');
    ok(d.q9 === 'Subscriptions sneak up on me each month.', 'q9 free text stored');
  }

  // -- Required field validation
  {
    writes.length = 0;
    const { req, res } = fakeReqRes('POST', {
      phone: phoneFor('svA'),
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
      phone: phoneFor('svB'),
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
      phone: phoneFor('svC'),
      source: 'hero',
      careerStage: 'Astronaut',
      lifeStage: 'Living alone',
    });
    await survey(req, res);
    ok(
      res.statusCode === 400 && res.body.reason === 'careerStage',
      'unknown careerStage rejected (allowlist enforced)',
    );
  }

  // -- Unanswered Likert fields are OMITTED (incremental merge: a blank field
  //    must never overwrite a previously saved answer).
  {
    writes.length = 0;
    const { req, res } = fakeReqRes('POST', {
      phone: phoneFor('sparse'),
      source: 'hero',
      careerStage: 'Retired',
      lifeStage: 'Living alone',
      q1: '4', // only q1, others missing
    });
    await survey(req, res);
    ok(res.statusCode === 200, 'sparse survey accepted (Likert is optional per question)');
    const d = writes[0]?.doc || {};
    ok(d.q1 === 4, 'q1 stored as integer 4');
    ok(!('q5' in d) && !('q7' in d), 'unanswered Likert fields are omitted, not written');
  }

  // -- Out-of-range / non-numeric Likert is omitted (never stored as junk)
  {
    writes.length = 0;
    const { req, res } = fakeReqRes('POST', {
      phone: phoneFor('oof'),
      source: 'hero',
      careerStage: 'Retired',
      lifeStage: 'Living alone',
      q1: '7',
      q2: 'haha',
      q3: '-1',
    });
    await survey(req, res);
    const d = writes[0]?.doc || {};
    ok(
      !('q1' in d) && !('q2' in d) && !('q3' in d),
      'out-of-range / non-numeric Likert is omitted (not stored as junk)',
    );
  }

  // -- q8 Yes/No allowlist, invalid value is omitted
  {
    writes.length = 0;
    const { req, res } = fakeReqRes('POST', {
      phone: phoneFor('yn'),
      source: 'hero',
      careerStage: 'Retired',
      lifeStage: 'Living alone',
      q8: 'Maybe',
    });
    await survey(req, res);
    ok(!('q8' in (writes[0]?.doc || {})), 'q8 outside Yes/No allowlist is omitted');
  }

  console.log('\n\x1b[1m== Survey progressive autosave (phone-keyed upsert) ==\x1b[0m');

  // -- Partial autosave: partial:true → upserts one phone-keyed doc with
  //    relaxed validation (no source/careerStage/lifeStage required).
  {
    writes.length = 0;
    const phone = phoneFor('partial');
    const { req, res } = fakeReqRes('POST', {
      phone,
      partial: true,
      careerStage: 'Student',
    });
    await survey(req, res);
    const d = docStore.get('survey/' + phoneDocId(phone)) || {};
    ok(res.statusCode === 200, 'partial autosave (partial:true) → 200');
    ok(res.body.id === phoneDocId(phone), 'doc id is the phone-derived key');
    ok(res.body.complete === false, 'partial response echoes complete:false');
    ok(!('complete' in d), 'partial write omits complete (so a merge can never downgrade it)');
    ok(d.careerStage === 'Student', 'partial captured the answered field');
    ok(d.phone === phone, 'phone stored as a field for lookups');
    ok('updatedAt' in d, 'partial write stamps updatedAt');
  }

  // -- Changing an answer overwrites the SAME phone-keyed doc (no duplicate)
  {
    writes.length = 0;
    const phone = phoneFor('ow');
    const base = { phone, partial: true };
    const { req: r1, res: w1 } = fakeReqRes('POST', { ...base, q1: '2' });
    await survey(r1, w1);
    const { req: r2, res: w2 } = fakeReqRes('POST', { ...base, q1: '5' });
    await survey(r2, w2);
    const d = docStore.get('survey/' + phoneDocId(phone)) || {};
    ok(d.q1 === 5, 'changed answer overwrites in place (q1: 2 → 5)');
    const ids = new Set(writes.map((w) => w.id));
    ok(ids.size === 1 && ids.has(phoneDocId(phone)), 'both writes hit the one phone doc (no dup)');
  }

  // -- Abandoner dedup: a second SESSION for the same number reuses the doc,
  //    and punctuation-insensitivity means a formatted number maps to the same
  //    key. (The client re-sends the full snapshot each save, so session 2
  //    carries q1 forward and adds q2, mirroring real behavior.)
  {
    writes.length = 0;
    const phone = phoneFor('dedup');
    const digits = phone.slice(2);
    const pretty = '(' + digits.slice(0, 3) + ') ' + digits.slice(3, 6) + '-' + digits.slice(6);
    const { req: r1, res: w1 } = fakeReqRes('POST', {
      phone: pretty, // formatted, no country code
      partial: true,
      q1: '1',
    });
    await survey(r1, w1);
    const { req: r2, res: w2 } = fakeReqRes('POST', {
      phone, // canonical E.164
      partial: true,
      q1: '1',
      q2: '4',
    });
    await survey(r2, w2);
    const key = phoneDocId(phone);
    const d = docStore.get('survey/' + key) || {};
    ok(w1.body.id === key && w2.body.id === key, 'formatted vs E.164 number maps to one doc key');
    ok(d.q1 === 1 && d.q2 === 4, 'second session reuses the same phone doc (no duplicate)');
  }

  // -- Complete submit for the same number flips complete:true in place
  {
    writes.length = 0;
    const phone = phoneFor('complete');
    const { req: r1, res: w1 } = fakeReqRes('POST', { phone, partial: true, q1: '3' });
    await survey(r1, w1);
    const { req: r2, res: w2 } = fakeReqRes('POST', {
      phone,
      complete: true,
      source: 'hero',
      careerStage: 'Retired',
      lifeStage: 'Living alone',
      q1: '3',
    });
    await survey(r2, w2);
    const d = docStore.get('survey/' + phoneDocId(phone)) || {};
    ok(w2.statusCode === 200, 'complete submit → 200');
    ok(w2.body.complete === true, 'response echoes complete:true');
    ok(d.complete === true, 'complete submit flips complete:true on the same phone doc');
    ok(d.q1 === 3, 'answers preserved through the complete write');
  }

  // -- NO-WIPE: a later write that OMITS a field must not erase it. This is the
  //    returning-user bug, reopening on a blank form and answering one more
  //    question must accumulate, not clobber the rest.
  {
    writes.length = 0;
    const phone = phoneFor('nowipe');
    // First save: only q1.
    const { req: r1, res: w1 } = fakeReqRes('POST', { phone, partial: true, q1: '5' });
    await survey(r1, w1);
    // Later save: only q2 (q1 absent entirely, simulates a fresh form).
    const { req: r2, res: w2 } = fakeReqRes('POST', { phone, partial: true, q2: '2' });
    await survey(r2, w2);
    const d = docStore.get('survey/' + phoneDocId(phone)) || {};
    ok(d.q1 === 5, 'earlier answer (q1) preserved when a later write omits it');
    ok(d.q2 === 2, 'new answer (q2) accumulates into the same record');
  }

  // -- Completion is sticky: a partial autosave after completion can't downgrade it
  {
    writes.length = 0;
    const phone = phoneFor('sticky');
    const { req: r1, res: w1 } = fakeReqRes('POST', {
      phone,
      complete: true,
      source: 'hero',
      careerStage: 'Retired',
      lifeStage: 'Living alone',
      q1: '3',
    });
    await survey(r1, w1);
    const { req: r2, res: w2 } = fakeReqRes('POST', { phone, partial: true, q2: '4' });
    await survey(r2, w2);
    const d = docStore.get('survey/' + phoneDocId(phone)) || {};
    ok(d.complete === true, 'stored completion survives a later partial autosave (not downgraded)');
  }

  // -- Completing the survey promotes the matching waitlist doc into the
  //    survey-completed tier (priorityScore jumps by ~1e9) and reports position.
  {
    const phone = phoneFor('promote');
    // First, a normal waitlist signup creates the waitlist doc (non-completer).
    const { req: rw, res: ww } = fakeReqRes('POST', { phone, source: 'hero' });
    await waitlist(rw, ww);
    const wlId = phoneDocId(phone);
    const before = docStore.get('waitlist/' + wlId) || {};
    ok(
      before.surveyComplete === false && before.priorityScore < 0,
      'pre-survey: non-completer, negative score',
    );

    const { req, res } = fakeReqRes('POST', {
      phone,
      complete: true,
      source: 'hero',
      careerStage: 'Student',
      lifeStage: 'Living alone',
    });
    await survey(req, res);
    const after = docStore.get('waitlist/' + wlId) || {};
    ok(
      after.surveyComplete === true,
      'survey completion sets surveyComplete:true on the waitlist doc',
    );
    ok(after.priorityScore > 9e8, 'completion lifts priorityScore into the +1e9 tier');
    ok(
      typeof res.body.position === 'number' && res.body.position >= 1,
      'survey complete returns a position',
    );
  }

  // -- Partial write still requires a plausible phone (it IS the doc key)
  {
    writes.length = 0;
    const { req, res } = fakeReqRes('POST', { partial: true, q1: '3' });
    await survey(req, res);
    ok(res.statusCode === 400 && res.body.reason === 'phone', 'partial without phone → 400 phone');
  }

  // -- q9 formula injection defused
  {
    writes.length = 0;
    const { req, res } = fakeReqRes('POST', {
      phone: phoneFor('inj'),
      source: 'hero',
      careerStage: 'Retired',
      lifeStage: 'Living alone',
      q9: '=HYPERLINK("https://evil.com","Click me")',
    });
    await survey(req, res);
    const got = writes[0]?.doc.q9;
    ok(got.startsWith("'="), 'q9 formula injection: leading = prefixed with apostrophe');
  }

  // -- q9 control char strip + length cap
  {
    writes.length = 0;
    const bigText = 'A'.repeat(3000) + '\x00 nullbyte';
    const { req, res } = fakeReqRes('POST', {
      phone: phoneFor('big'),
      source: 'hero',
      careerStage: 'Retired',
      lifeStage: 'Living alone',
      q9: bigText,
    });
    await survey(req, res);
    const got = writes[0]?.doc.q9;
    ok(got.length === 2000, 'q9 capped at 2000 chars');
    ok(!got.includes('\x00'), 'q9 null byte stripped');
  }

  // -- IP hashing stability, explicit same IP across two requests
  {
    writes.length = 0;
    const { req: r1, res: w1 } = fakeReqRes(
      'POST',
      { phone: phoneFor('iphash1'), source: 'hero' },
      { ip: '198.51.100.7' },
    );
    const { req: r2, res: w2 } = fakeReqRes(
      'POST',
      { phone: phoneFor('iphash2'), source: 'hero' },
      { ip: '198.51.100.7' },
    );
    await waitlist(r1, w1);
    await waitlist(r2, w2);
    const ipw = wlWrites();
    ok(ipw[0].doc.ipHash === ipw[1].doc.ipHash, 'same IP → same ipHash (correlation works)');
  }

  // -- IP hashing salt missing → null (no insecure fallback)
  {
    const saved = process.env.IP_HASH_SALT;
    delete process.env.IP_HASH_SALT;
    writes.length = 0;
    const { req, res } = fakeReqRes('POST', { phone: phoneFor('nosalt'), source: 'hero' });
    await waitlist(req, res);
    ok(
      wlWrites()[0]?.doc.ipHash === null,
      'missing salt → ipHash is null (fails closed, not open)',
    );
    process.env.IP_HASH_SALT = saved;
  }

  console.log('\n\x1b[1m== App Check (reCAPTCHA v3) ==\x1b[0m');

  // -- Without secret: verification is skipped (back-compat / staging)
  {
    delete process.env.RECAPTCHA_SECRET_KEY;
    writes.length = 0;
    const { req, res } = fakeReqRes('POST', { phone: phoneFor('norecaptcha'), source: 'hero' });
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
      phone: phoneFor('notok'),
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
      phone: phoneFor('human'),
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
      phone: phoneFor('bot'),
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
      phone: phoneFor('degraded'),
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
        { phone: phoneFor('burst' + i), source: 'hero' },
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
      { phone: phoneFor('still-over'), source: 'hero' },
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
        phone: phoneFor('separate'),
        source: 'hero',
        careerStage: 'Retired',
        lifeStage: 'Living alone',
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
