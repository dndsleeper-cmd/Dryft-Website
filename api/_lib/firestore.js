/**
 * Firebase Admin singleton.
 *
 * Vercel reuses serverless function instances (warm starts) for several
 * minutes, so initializing the SDK on every cold start is fine — but we
 * must guard against double-init on warm reuse, which throws.
 *
 * Credentials come from env vars set in the Vercel dashboard. Never commit
 * them to the repo. See .env.example for the variable names.
 */
const admin = require('firebase-admin');

let app = null;

function getAdmin() {
  if (app) return app;

  if (admin.apps.length) {
    app = admin.apps[0];
    return app;
  }

  const projectId = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  // Vercel stores the private key with literal "\n" sequences; convert to
  // real newlines before handing it to the SDK.
  const privateKey = (process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n');

  if (!projectId || !clientEmail || !privateKey) {
    throw new Error(
      'Firebase Admin not configured. Set FIREBASE_PROJECT_ID, ' +
        'FIREBASE_CLIENT_EMAIL, and FIREBASE_PRIVATE_KEY in Vercel.',
    );
  }

  app = admin.initializeApp({
    credential: admin.credential.cert({ projectId, clientEmail, privateKey }),
  });
  return app;
}

function db() {
  getAdmin();
  return admin.firestore();
}

function serverTimestamp() {
  return admin.firestore.FieldValue.serverTimestamp();
}

module.exports = { getAdmin, db, serverTimestamp, admin };
