#!/usr/bin/env node
/**
 * ONE-TIME MIGRATION v2, survey question set trimmed 12 → 9 fields
 * ================================================================================
 *
 * The survey dropped three Likert questions (old q6 "too strict", old q8 "tried
 * before", old q10 "life changes") and renumbered the rest so stored field names
 * keep matching on-screen display order. The remap over a doc is:
 *
 *     new.q1 = old.q1   (unchanged, Likert)
 *     new.q2 = old.q2   (unchanged, Likert)
 *     new.q3 = old.q3   (unchanged, Likert)
 *     new.q4 = old.q4   (unchanged, Likert)
 *     new.q5 = old.q5   (unchanged, Likert)
 *     new.q6 = old.q7   (Likert  | deleted)   "mentally exhausting"
 *     new.q7 = old.q9   (Likert  | deleted)   "improve my spending habits"
 *     new.q8 = old.q11  (Yes/No  | deleted)   "comfortable with app analyzing"
 *     new.q9 = old.q12  (text    | deleted)   open-ended
 *    , old q6, q8, q10 are dropped entirely
 *    , old q11, q12 are removed once copied into q8, q9
 *
 * careerStage, lifeStage, email and everything else are untouched.
 *
 * ⚠️  RUN THIS BEFORE DEPLOYING THE NEW FRONTEND/API.  ⚠️
 * ------------------------------------------------------------
 * After the new code is live, fields q6 and q7 are Likert under BOTH schemas but
 * carry DIFFERENT questions, so old and new docs become indistinguishable by type
 * and a safe in-place remap is no longer possible. Run this while every stored doc
 * is still on the old schema. The `_surveyFieldsV2At` marker makes re-runs no-ops,
 * so a second pass (e.g. right after deploy) skips already-migrated docs, but it
 * cannot protect docs written by the NEW code, hence: migrate first, then deploy.
 *
 * USAGE
 * -----
 *   1. Put Firebase service-account creds in a gitignored .env.local (see
 *      .env.example): FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY.
 *
 *   2. DRY RUN first (default, reads only, writes nothing):
 *        node --env-file=.env.local scripts/migrate-survey-v2.js
 *
 *   3. APPLY once the preview looks right:
 *        node --env-file=.env.local scripts/migrate-survey-v2.js --commit
 *
 *   (Node < 20.6 without --env-file works too; the script parses .env.local itself.)
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
const DELETE = Symbol('delete');
const asLikert = (v) => (Number.isInteger(v) && v >= 1 && v <= 5 ? v : DELETE);
const asYesNo = (v) => (v === 'Yes' || v === 'No' ? v : DELETE);
const asText = (v) => (typeof v === 'string' && v.length > 0 ? v : DELETE);

// A doc still on the OLD schema lacks the v2 marker. (Run before deploy, so every
// doc in the collection is old-schema, the marker is purely for re-run safety.)
function needsMigration(d) {
  return !d._surveyFieldsV2At;
}

// Build the field-level update: real values to set, DELETE sentinels to remove.
function buildUpdate(d) {
  const set = {
    q6: asLikert(d.q7 ?? null), // was q7 , "mentally exhausting"
    q7: asLikert(d.q9 ?? null), // was q9 , "improve my spending habits"
    q8: asYesNo(d.q11 ?? ''), // was q11, Yes/No
    q9: asText(d.q12 ?? ''), // was q12, open text
    // Old dropped Likerts and the now-moved fields are removed outright.
    q10: DELETE,
    q11: DELETE,
    q12: DELETE,
  };
  const update = {};
  for (const [k, v] of Object.entries(set)) {
    update[k] = v === DELETE ? FieldValue.delete() : v;
  }
  return update;
}

// Plain (non-FieldValue) preview of what the doc's q6..q9 become, for dry-run logs.
function previewValues(d) {
  return {
    q6: asLikert(d.q7 ?? null),
    q7: asLikert(d.q9 ?? null),
    q8: asYesNo(d.q11 ?? ''),
    q9: asText(d.q12 ?? ''),
  };
}
const show = (v) => (v === DELETE ? '(deleted)' : JSON.stringify(v));

// ---- main -----------------------------------------------------------------
(async function main() {
  const mode = COMMIT ? 'COMMIT (writing changes)' : 'DRY RUN (no writes)';
  console.log(`\n  Survey field migration v2, ${mode}`);
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

    if (samplesShown < 5) {
      samplesShown++;
      const next = previewValues(d);
      console.log(`  • ${doc.id}`);
      console.log(
        `      old: q7=${d.q7} q9=${d.q9} q11=${JSON.stringify(d.q11)} q12=${JSON.stringify(
          (d.q12 || '').slice(0, 40),
        )}`,
      );
      console.log(
        `      new: q6=${show(next.q6)} q7=${show(next.q7)} q8=${show(next.q8)} q9=${show(next.q9)}`,
      );
    }

    if (COMMIT) {
      const update = buildUpdate(d);
      update._surveyFieldsV2At = FieldValue.serverTimestamp();
      batch.update(doc.ref, update);
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
  console.log(`  already v2:     ${skipped}  (skipped)`);
  console.log(`  ${COMMIT ? 'migrated:      ' : 'would migrate: '} ${toMigrate}`);
  if (COMMIT) console.log(`  batches written: ${committedBatches}`);
  if (!COMMIT && toMigrate > 0) {
    console.log('\n  Dry run only, re-run with --commit to apply.');
  }
  if (toMigrate === 0) {
    console.log('\n  Nothing to do, all docs already carry the v2 marker. ✓');
  }
  console.log('');

  process.exit(0);
})().catch((err) => {
  console.error('\n  ✗ Migration failed:', err && err.message ? err.message : err);
  process.exit(1);
});
