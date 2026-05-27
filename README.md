# Dryft

Marketing site + waitlist/survey collection for **Dryft** — a budget that adapts to real life. Hosted on Vercel at <https://thedryft.com>.

This repository is the **public-facing site**, not the Dryft app itself. The product (iOS/Android client + ML coaching engine) lives in a separate, private repository.

## Stack

| Layer           | Choice                                                | Why                                                                                  |
| --------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Hosting         | Vercel (Hobby tier)                                   | Zero-config static + serverless on the same domain                                   |
| Static frontend | Hand-rolled HTML + vanilla JS + CSS                   | No framework needed for a one-page site; keeps the bundle tiny and the page snappy   |
| Data store      | Firebase Firestore                                    | Free tier covers waitlist scale; deny-all security rules + Admin-SDK-only writes     |
| API layer       | Vercel serverless functions (`api/*.js`)              | Same-origin POSTs from the site; service account credentials never reach the browser |
| Anti-abuse      | reCAPTCHA v3 (App Check) + Upstash Redis (rate limit) | Both fail-closed and optional; the site works before either is provisioned           |

```
[Browser]
  │ POST /api/waitlist  (same-origin, JSON)
  ▼
[Vercel serverless function]   ← validates, App Check, rate limit
  │ Firebase Admin SDK (service account from env vars)
  ▼
[Firestore]                    ← deny-all client access; Admin SDK bypasses
```

## Local development

```bash
# Install deps (firebase-admin is the only runtime dep)
npm install

# Run the test suite (uses mocked Firestore, no real creds needed)
npm test

# Serve the static files locally (any static server works; example):
npx http-server -p 8000
```

The API routes can be exercised locally with `vercel dev` if you have the Vercel CLI and a `.env.local` matching the production env vars. For most changes the unit-test harness is sufficient.

## Deployment

`main` is the production branch. Every push to `main` triggers a Vercel build + deploy. Preview deploys are spun up automatically for every other branch.

### Required environment variables (Vercel → Settings → Environment Variables)

| Name                    | Where to get it                                                   | Scope                |
| ----------------------- | ----------------------------------------------------------------- | -------------------- |
| `FIREBASE_PROJECT_ID`   | Firebase Console → Project settings → Service accounts JSON       | Production + Preview |
| `FIREBASE_CLIENT_EMAIL` | Same JSON, `client_email` field                                   | Production + Preview |
| `FIREBASE_PRIVATE_KEY`  | Same JSON, `private_key` field (keep `\n` as literal backslash-n) | Production + Preview |
| `IP_HASH_SALT`          | `openssl rand -hex 32`                                            | Production + Preview |

### Optional environment variables

| Name                                                  | Purpose                               | Without it                                                        |
| ----------------------------------------------------- | ------------------------------------- | ----------------------------------------------------------------- |
| `RECAPTCHA_SECRET_KEY`                                | Server-side reCAPTCHA v3 verification | Verification is skipped; client honeypot + rate limit still apply |
| `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN` | Durable distributed rate limit        | Falls back to in-memory rate limit on warm serverless instances   |

See [`.env.example`](.env.example) for the full template.

## Repository layout

```
api/                      Vercel serverless functions
  _lib/
    firestore.js          Firebase Admin singleton (cold-start safe)
    validate.js           Server-side sanitizers + verifyRecaptcha + rateLimit
  waitlist.js             POST endpoint — writes one doc to `waitlist`
  survey.js               POST endpoint — writes one doc to `survey`
assets/                   Static assets served at /assets/*
  css/styles.css          Single stylesheet; ~2200 lines
  js/main.js              Single client script; nav + survey + animations
  favicon.svg
docs/                     Internal design notes (gitignored from deploy via .vercelignore)
test/                     Mocked end-to-end test of the API handlers
firestore.rules           Deny-all client rules — paste into Firebase Console
index.html                Landing page
privacy.html              Privacy policy
terms.html                Terms of service
manifest.json             PWA manifest
sitemap.xml               Sitemap for search engines
robots.txt
.well-known/
  security.txt            Vulnerability disclosure contact
vercel.json               Hosting headers (CSP, HSTS, etc.) + redirects
```

## Security & compliance

- [`SECURITY.md`](SECURITY.md) — vulnerability disclosure policy
- [`firestore.rules`](firestore.rules) — deny-all; only the Admin SDK writes
- HSTS preload, strict CSP, X-Frame-Options, Cross-Origin-\* — see [`vercel.json`](vercel.json)
- IP addresses are hashed with a per-deploy salt before storage (`IP_HASH_SALT`)
- Spreadsheet formula injection is defused on free-text inputs (apostrophe prefix on `=+-@\t`)
- Service account credentials live as Vercel env vars; never touched by the browser

**You are not licensed to copy or redistribute this code.** All rights reserved © Dryft.

## License

Proprietary. This repository is published only for transparency and operational convenience; no rights are granted to fork, copy, or use the code or content. See the proprietary notice above.
