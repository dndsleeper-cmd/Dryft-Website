# Security policy

## Supported versions

This is the live production marketing site, only the currently-deployed `main` branch is supported. Vulnerabilities are addressed in `main` and rolled out via the next Vercel deploy.

## Reporting a vulnerability

**Please email <security@thedryft.com>** with:

- A description of the issue, including the URL or endpoint affected
- Steps to reproduce (a curl command, screenshot, or short video is ideal)
- Your name / handle if you'd like credit in the disclosure

We aim to:

| Step                                        | SLA                    |
| ------------------------------------------- | ---------------------- |
| Acknowledge receipt                         | within 48 hours        |
| Initial triage + severity rating            | within 5 business days |
| Fix deployed for high/critical issues       | within 14 days         |
| Public disclosure (with credit, if desired) | after a fix is live    |

## Scope

In scope:

- `thedryft.com` and `www.thedryft.com` (the marketing site)
- The Vercel serverless API endpoints under `/api/*`
- The Firestore project `dryft` (if you find a misconfiguration via the public site, please report it)
- Public-facing security headers, CSP, CORS, TLS configuration

Out of scope:

- The Dryft mobile app (separate repository; report through the app's own channel)
- Third-party services we depend on (Vercel, Firebase, Google Fonts), please report directly to them
- Denial-of-service / volumetric attacks (covered by Vercel's edge protections)
- Social-engineering attacks against Dryft staff

## Safe harbor

We will not pursue legal action against researchers who:

- Make a good-faith effort to avoid privacy violations, destruction of data, and interruption of service
- Only interact with accounts they own or have explicit permission to access
- Give us reasonable time to fix the issue before any public disclosure
- Do not exploit the vulnerability beyond what's needed to demonstrate it

## Existing security posture

| Control                             | Implementation                                                                                                                  |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Transport                           | HSTS preload (`max-age=63072000`), TLS 1.3 via Vercel                                                                           |
| Content Security Policy             | Strict CSP defined in [`vercel.json`](vercel.json); `default-src 'self'`                                                        |
| Frame protection                    | `X-Frame-Options: DENY` + `frame-ancestors 'none'` in CSP                                                                       |
| Cross-origin isolation              | COOP `same-origin`, CORP `same-origin`                                                                                          |
| Permissions Policy                  | All sensors and credential APIs explicitly denied                                                                               |
| Firestore access                    | Deny-all rules; only the Vercel serverless function (Admin SDK) writes                                                          |
| Credential hygiene                  | Service account credentials live as Vercel env vars; never reach the browser                                                    |
| Input validation                    | Allowlists for enums, regex+structural for emails, range checks for integers, control-char stripping + length cap for free text |
| Formula injection (spreadsheet/CSV) | Apostrophe prefix on values starting with `=+-@\t\r`                                                                            |
| PII minimization                    | IP addresses are hashed with a per-deploy salt before storage                                                                   |
| Abuse mitigation                    | reCAPTCHA v3 (App Check), IP-based rate limiting (Upstash with in-memory fallback), client-side honeypot + dwell-time gate      |
| Dependency security                 | Dependabot security alerts enabled; `npm audit` reviewed before deploy                                                          |
