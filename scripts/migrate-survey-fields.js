#!/usr/bin/env node
/**
 * ONE-TIME MIGRATION — survey field renumbering (old schema → display-order schema)
 * =================================================================================
 *
 * Renames the survey question fields so the stored field names match the
 * on-screen display order. The five affected fields form a PERMUTATION over the
 * same key set {q7, q8, q9, q10, q11} — no keys are added or removed, only their
 * values are shuffled:
 *
 *     new.q7  = old.q8     (Likert 1–5  | null)
 *     new.q8  = old.q9     (Likert 1–5  | null)
 *     new.q9  = old.q10    (Likert 1–5  | null)
 *     new.q10 = old.q11    (Likert 1–5  | null)
 *     new.q11 = old.q7     (Yes/No string)
 *
 * q1–q6, q12, careerStage, lifeStage and everything else are untouched.
 *
 * IDEMPOTENT BY CONSTRUCTION
 * --------------------------
 * Old-schema docs have a STRING q7 ('Yes' | 'No' | ''). New-schema docs have a
 * numeric/null q7 and a STRING q11. The script only migrates a doc when
 * `typeof q7 === 'string'`. After migration q7 is numeric/null, so a re-run
 * skips it. This also means it is safe to run AFTER the new code is deployed:
 * freshly-written new-schema docs are left alone.
 *
 * USAGE
 * -----
 *   1. Put your Firebase service-account creds in a local, gitignored .env.local
 *      (same var names the app uses — see .env.example):
 *
 *        FIREBASE_PROJECT_ID=...
 *        FIREBASE_CLIENT_EMAIL=...
 *        FIREBASE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n"
 *
 *   2. DRY RUN first (default — reads only, writes nothing):
 *
 *        node --env-file=.env.local scripts/migrate-survey-fields.js
 *
 *   3. APPLY for real once the preview looks right:
 *
 *        node --env-file=.env.local scripts/migrate-survey-fields.js --commit
 *
 *   (If your Node is < 20.6 and lacks --env-file, the script also parses
 *    .env.local itself, so plain `node scripts/migrate-survey-fields.js` works.)
 *
 * FLAGS
 *   --commit         Actually write changes. Without it, runs a dry run.
 *   --collection=X   Override the collection name (default: "survey").
 *   --limit=N        Only process the first N docs (handy for a test pass).
 */

'use strict';

const fs = require('fs');
const path = require('path');
const admin = require('firebase-admin');

// ---- args -----------------------------------------------------------------
const args = process.argv.slice(2);
const COMMIT = args.includes('--commit') || args.includes('--apply');
const getFlag = (name, def) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=').slice(1).join('=') : def;
};
const COLLECTION = getFlag('collection', 'survey');
const LIMIT = parseInt(getFlag('limit', '0'), 10) || 0;

// ---- minimal .env.local loader (only if vars not already in the env) ------
// Lets the script work whether you use `node --env-file=.env.local` or not.
(function loadDotEnvLocal() {
  if (
    process.env.FIREBASE_PROJECT_ID &&
    process.env.FIREBASE_CLIENT_EMAIL &&
    process.env.FIREBASE_PRIVATE_KEY
  ) {
    return; // already provided (e.g. via --env-file or exported)
  }
  const p = path.resolve(process.cwd(), '.env.local');
  if (!fs.existsSync(p)) return;
  for (const raw of fs.readFileSync(p, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = val;
  }
})();

// ---- firebase init --------------------------------------------------------
const projectId = process.env.FIREBASE_PROJECT_ID;
const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
const privateKey = (process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n');

if (!projectId || !clientEmail || !privateKey) {
  console.error(
    '\n  ✗ Firebase Admin not configured.\n' +
      '    Set FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL and FIREBASE_PRIVATE_KEY\n' +
      '    (e.g. in a gitignored .env.local) and re-run. See .env.example.\n',
  );
  process.exit(1);
}

admin.initializeApp({
  credential: admin.credential.cert({ projectId, clientEmail, privateKey }),
});
const db = admin.firestore();
const { FieldValue } = admin.firestore;

// ---- helpers --------------------------------------------------------------
const isLikert = (v) => v === null || (Number.isInteger(v) && v >= 1 && v <= 5);
const asLikert = (v) => (isLikert(v) ? v : Number.isInteger(v) ? v : null);
const asYesNo = (v) => (v === 'Yes' || v === 'No' ? v : '');

// A doc needs migration iff it carries the OLD-schema signature: a STRING q7.
function needsMigration(d) {
  return typeof d.q7 === 'string';
}

function buildNewValues(d) {
  return {
    q7: asLikert(d.q8 ?? null), // was q8
    q8: asLikert(d.q9 ?? null), // was q9
    q9: asLikert(d.q10 ?? null), // was q10
    q10: asLikert(d.q11 ?? null), // was q11
    q11: asYesNo(d.q7 ?? ''), // was q7 (Yes/No)
    _fieldsMigratedAt: COMMIT ? FieldValue.serverTimestamp() : '(dry-run)',
  };
}

// ---- main -----------------------------------------------------------------
(async function main() {
  const mode = COMMIT ? 'COMMIT (writing changes)' : 'DRY RUN (no writes)';
  console.log(`\n  Survey field migration — ${mode}`);
  console.log(`  Collection: "${COLLECTION}"${LIMIT ? `  (limit ${LIMIT})` : ''}\n`);

  const snap = await db.collection(COLLECTION).get();
  let total = 0;
  let toMigrate = 0;
  let skipped = 0;
  let samplesShown = 0;

  let batch = db.batch();
  let pending = 0;
  let committedBatches = 0;

  for (const doc of snap.docs) {
    if (LIMIT && total >= LIMIT) break;
    total++;
    const d = doc.data();

    if (!needsMigration(d)) {
      skipped++;
      continue;
    }
    toMigrate++;

    const next = buildNewValues(d);

    // Show the first few diffs so you can eyeball correctness before committing.
    if (samplesShown < 5) {
      samplesShown++;
      console.log(`  • ${doc.id}`);
      console.log(
        `      old: q7=${JSON.stringify(d.q7)} q8=${d.q8} q9=${d.q9} q10=${d.q10} q11=${d.q11}`,
      );
      console.log(
        `      new: q7=${next.q7} q8=${next.q8} q9=${next.q9} q10=${next.q10} q11=${JSON.stringify(next.q11)}`,
      );
    }

    if (COMMIT) {
      const { _fieldsMigratedAt, ...fields } = next;
      batch.update(doc.ref, { ...fields, _fieldsMigratedAt });
      pending++;
      if (pending >= 400) {
        await batch.commit();
        committedBatches++;
        batch = db.batch();
        pending = 0;
      }
    }
  }

  if (COMMIT && pending > 0) {
    await batch.commit();
    committedBatches++;
  }

  console.log('\n  ── Summary ──────────────────────────────');
  console.log(`  scanned:        ${total}`);
  console.log(`  already new:    ${skipped}  (skipped)`);
  console.log(`  ${COMMIT ? 'migrated:      ' : 'would migrate: '} ${toMigrate}`);
  if (COMMIT) console.log(`  batches written: ${committedBatches}`);
  if (!COMMIT && toMigrate > 0) {
    console.log('\n  Dry run only — re-run with --commit to apply.');
  }
  if (toMigrate === 0) {
    console.log('\n  Nothing to do — all docs are already on the new schema. ✓');
  }
  console.log('');

  process.exit(0);
})().catch((err) => {
  console.error('\n  ✗ Migration failed:', err && err.message ? err.message : err);
  process.exit(1);
});
