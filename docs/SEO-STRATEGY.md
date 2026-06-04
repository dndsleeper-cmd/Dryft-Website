# Dryft — SEO Strategy & Technical Audit

> Scope: thedryft.com (static site on Vercel). Reviewed files: `index.html`, `referral.html`,
> `privacy.html`, `terms.html`, `robots.txt`, `sitemap.xml`, `vercel.json`,
> `assets/css/styles.css`, `assets/js/main.js`, structured-data graph in `index.html`.
> Positioning: AI money app that helps you **save without budgeting, tracking, or guilt**.
> ICP: students & young professionals (18–35) who want to hit savings/investing goals
> without strict budgets, spreadsheets, or constant discipline.

**The one-sentence diagnosis:** the site is technically clean and well-secured, but it is a
single-page waitlist with almost no indexable content and **zero keyword targeting in the
title/H1**, so it can only ever rank for "dryft" (brand). The growth unlock is (1) put the
money keywords into the homepage's title/H1/H2 signals and (2) stand up a content engine for
topical authority + long-tail capture. Everything below is ordered to do those two things.

Status legend for items already shipped in this pass: ✅ done · ◻️ recommended (not yet applied).

---

## 1. Full Technical SEO Audit

| # | Issue | SEO impact | Exact fix | Priority |
|---|-------|-----------|-----------|----------|
| 1 | **Title tag has no commercial keyword.** `index.html:6` = `Dryft: Become better at money, without thinking about it.` | Can't rank for "budgeting app", "save money without budgeting", etc. Brand-only title. | Rewrite to lead with the money keyword + brand (see §3). e.g. `Save Money Without Budgeting — Dryft AI Money App`. | **High** |
| 2 | **H1 has no target keyword.** `index.html:224` = `become better at money, without thinking about it.` | Google's strongest on-page relevance signal carries no query term. | Keep the brand line but add a keyword-bearing fragment, or add a keyword H2 directly below (see §3). | **High** |
| 3 | **Thin indexable content.** Homepage body is hero + 4 micro-steps + CTA + team + 3 trust rows + 5 FAQ. ~400–500 words. | Limited surface area to rank; few entities for Google to associate Dryft with. | Expand homepage prose (done partially via FAQ/trust copy ✅) and launch `/blog` (see §4–5). | **High** |
| 4 | **No content hub / blog → ~0 topical authority.** No `/blog`, no articles, no internal content links. | Cannot capture the large long-tail ("how to save money without budgeting", "why budgeting fails"). | Build `/blog` + publish the pillar+cluster set in §4–5. | **High** |
| 5 | **FAQ structured data vs visible content.** `FAQPage` JSON-LD (`index.html:143`) previously had **no visible FAQ** (section was commented out). | Schema-without-visible-content violates Google FAQ guidelines → ineligible/penalty risk. | ✅ Fixed this pass: FAQ section restored under Team and visible answers aligned to the JSON-LD. Keep them in sync going forward. | **High** (resolved) |
| 6 | **`/assets/*` cached only 300s.** `vercel.json:52-62` → `Cache-Control: public, max-age=300, must-revalidate`. All assets are query-versioned (`?v=`). | Repeat visitors re-validate fonts/CSS/JS/images every 5 min → slower repeat-visit LCP, weaker CWV field data. | Set versioned assets to `max-age=31536000, immutable`. First add `?v=` to the two un-versioned icon links (`index.html:45,47`). Snippet in §9. | **Medium** |
| 7 | **Team images are PNG @ 1000×1000 (~0.5–1.3 MB each).** `assets/images/team/*.png`. | 4 large PNGs add page weight; on slow mobile this risks LCP/INP if they enter viewport. They are `loading="lazy"` + below the fold, which limits damage. | Export WebP/AVIF (≈80–90% smaller) and serve via `<picture>`; keep PNG fallback. | **Medium** |
| 7b | **Hero LCP image** `assets/images/background.jpg` is preloaded with `fetchpriority="high"` (`index.html:70`). Good. | LCP-positive. | Confirm it's also WebP/AVIF; it's the LCP element so format matters most here. | **Medium** |
| 8 | **OG image art is stale.** `og-image.png` visually reads the old tagline ("reach your goals without budgeting"). `alt` updated ✅ but the rendered image is unchanged. | Lower social/Discord/iMessage CTR; mismatched messaging. | Regenerate `og-image.png` (1200×630) with current hero line + "Private Beta 01"; bump `?v=`. | **Medium** |
| 9 | **Sitemap was missing `/referral` and had stale `lastmod`.** `sitemap.xml`. | `/referral` (an indexable, linkable page) wasn't advertised; stale dates reduce crawl signal. | ✅ Fixed this pass: added `/referral` (priority 0.6) and refreshed `lastmod` to 2026-06-04. Add `/blog` + posts as they ship. | **Low** (resolved) |
| 10 | **Heading hierarchy gaps.** How-it-works steps use `<h4>` (`index.html` `.hiw-step h4`) with no section-level `<h2>` introducing them. | Skipped levels (h1→h4) weaken topical structure for crawlers and screen readers. | Add an `<h2>` to the how-it-works section, e.g. `How Dryft works: predict, nudge, adapt — no budgeting required`. | **Medium** |
| 11 | **"Who it's for" not stated on-page.** Hero + steps describe *what*; ICP (students/young pros who hate budgeting) is implicit. | Misses intent match for "budgeting app for students / for people who hate budgeting". | Add an ICP line in hero subhead or a short "Built for…" strip (copy in §3). Partly addressed via trust copy ✅. | **Medium** |
| 12 | **No `Review`/`AggregateRating` schema.** `SoftwareApplication` (`index.html:99`) has `offers` but no ratings. | Missing star rich-result eligibility. | **Do not fake.** Add `aggregateRating` only once you have real reviews/testimonials (see §7 for the gated snippet). | **Low** |
| 13 | **Internal linking is nav/footer only.** Nav: Invite code→`/referral`, Join free→`#waitlist`; footer: privacy/terms/mailto. No contextual links. | No link equity flow to deep content (because none exists yet). | Solve via blog cross-linking + homepage links to pillar pages (see §5). | **Medium** (after §4) |
| 14 | Title/meta/canonical/OG/Twitter present and correct on all 4 pages; `robots.txt` is well-built (allows Googlebot + AI search bots, blocks AI training); breadcrumb JSON-LD exists on `/privacy` & `/terms`; CSP/security headers are strong; CLS-safe `width/height` on images; self-hosted preloaded fonts. | Positive baseline. | Keep. These are above-average for a pre-launch site. | — |

**Core Web Vitals risk summary**
- **LCP:** hero `background.jpg` preloaded + hero font preloaded → good. Verify image is AVIF/WebP.
- **CLS:** images carry `width/height`; fonts preloaded → low risk. Good.
- **INP:** `main.js` runs the notification/chat demos + survey modal. Keep handlers passive; lazy-init below-fold demos. Low risk currently.
- **Repeat-visit perf:** capped by Issue #6 (300s asset cache). Fixing it is the single biggest field-data win.

**Accessibility items that touch SEO**
- Skip-link present (`index.html:196`), form inputs have `sr-only` labels, decorative demos are `aria-hidden`, social links have `aria-label` ✅.
- Verify text contrast for `--subtle (#8e9aa3)` on `--bg (#f4f6f7)` — borderline for small text; use `--muted` for body copy.
- Lowercase H1 is a styling choice (text is literally lowercase in markup) — fine for crawlers, but see §3 for the keyword fix.

---

## 2. Keyword Strategy

Difficulty = relative KD guess (Low/Med/High) for a new, low-authority domain. "Page" = where it should live.

### Primary (commercial / category)
| Keyword | Intent | Difficulty | Recommended page | Content angle |
|---|---|---|---|---|
| ai budgeting app | Commercial | High | Homepage + `/ai-budgeting-app` pillar | "AI that predicts drift & nudges — budgeting that runs itself." |
| budgeting app that doesn't require tracking | Commercial | Med | Homepage + pillar | Dryft's core wedge — read-only, no manual entry. |
| save money without budgeting | Commercial/Info | Med | `/save-money-without-budgeting` pillar | The category Dryft *owns*; anti-budget thesis. |
| automated budgeting app | Commercial | High | `/ai-budgeting-app` | Automation + adaptation vs static rules. |
| budgeting alternative | Commercial | Med | `/budgeting-alternatives` pillar | "Tried budgeting and failed? Here's the alternative." |
| behavioral finance app | Commercial | Med | Homepage + `/behavioral-finance` pillar | Behavioral nudges, present bias, friction. |
| save money automatically | Commercial | High | `/save-money-without-budgeting` | Auto-adapting plan vs manual saving. |

### Secondary (supporting / mid-funnel)
| Keyword | Intent | Difficulty | Recommended page | Content angle |
|---|---|---|---|---|
| money habits | Info | Med | `/money-habits` pillar | Habit loops applied to spending. |
| spending habits | Info | Med | `/spending-habits` | Track-free awareness of patterns. |
| financial goals app | Commercial | Med | `/financial-goals` pillar | Goal-based, lifestyle-preserving saving. |
| smarter spending | Info | Low | cluster article | Decide better in the moment, not after. |
| budgeting for students | Commercial | Med | `/budgeting-for-students` | $3.99 student wedge; no-discipline pitch. |
| how to stop overspending | Info | Med | cluster article | Drift detection + day-9 intervention. |
| save for a trip / car / emergency fund | Info/Commercial | Low–Med | programmatic goal pages (§6) | Calculator + plan per goal. |

### Long-tail (own these first — lowest difficulty, highest intent fit)
| Keyword | Intent | Difficulty | Recommended page | Content angle |
|---|---|---|---|---|
| how to save money without budgeting | Info | Low | `/save-money-without-budgeting` | Step-by-step anti-budget method. |
| budgeting for people who hate budgeting | Info | Low | cluster | Dryft's exact ICP phrase. |
| why budgeting fails | Info | Low | `/why-budgeting-fails` | Behavioral reasons budgets break. |
| save money without spreadsheets | Info | Low | cluster | No-spreadsheet workflow. |
| budgeting app that doesn't require tracking | Commercial | Low | pillar/homepage | Direct product match. |
| how to save money in your 20s without a strict budget | Info | Low | `/budgeting-for-students` cluster | Young-pro lifestyle + saving. |
| how to stop feeling guilty about spending | Info | Low | `/spending-psychology` cluster | Guilt → behavioral framing (ICP pain). |
| best budgeting app for people who are bad with money | Commercial | Low | `/budgeting-alternatives` | Empathy + product. |

**Why this mix:** the domain is new, so the realistic 0–6 month wins are the **Low-difficulty long-tails** that exactly match the ICP's own words ("hate budgeting", "without a strict budget", "feeling guilty about spending"). These also feed the pillars that will eventually contest the High-difficulty primary terms.

---

## 3. Homepage SEO Optimization

**Does the homepage answer the 4 questions today?**
- *What is Dryft?* — Partly. Hero is poetic ("become better at money"); the *category* (AI money app / budgeting alternative) is not stated.
- *Who is it for?* — Weak. ICP is implicit. (Improved via the trust copy this pass.)
- *Why different?* — Yes. How-it-works (predict → nudge → watch → adapt) is clear.
- *Why should Google rank it?* — No. No query-bearing terms in title/H1/H2.

### Title tag (rewrite)
Current (`index.html:6`): `Dryft: Become better at money, without thinking about it.`

Options (pick one — keyword-forward recommended while brand search is low):
- **A (recommended):** `Save Money Without Budgeting — Dryft AI Money App` (49 chars)
- B (brand-balanced): `Dryft — Save Money Without Budgeting or Tracking` (48 chars)
- C (ICP-forward): `Budgeting App for People Who Hate Budgeting — Dryft` (51 chars)

```html
<!-- index.html line 6 -->
<title>Save Money Without Budgeting — Dryft AI Money App</title>
```
Mirror into `og:title` (`:25`) and `twitter:title` (`:38`).

### Meta description (current is good; tighten to ICP)
```html
<meta name="description" content="Dryft is the AI money app for people who hate budgeting. Hit your savings goals without tracking every dollar, strict budgets, or spreadsheets — no guilt required. Join the waitlist.">
```
(157 chars; leads with category + ICP + benefit + CTA.) Mirror to `og:description` / `twitter:description`.

### H1 (two-tier — keep the brand line, give Google a keyword)
Lowest-risk option keeps the visible hero and adds a keyword `<h2>` immediately below. Stronger option edits the H1 itself:

```html
<!-- Stronger: keyword in the H1, brand line becomes the emotional subhead -->
<h1 class="statement-h1">
  <span class="statement-line1">save money without budgeting,</span><br>
  <span class="statement-line2">without thinking about it.</span>
</h1>
<p class="statement-sub">The AI money app that helps students and young professionals hit their goals — no strict budgets, no tracking, no guilt.</p>
```
This keeps the cadence and the "without thinking about it." payoff while putting **"save money without budgeting"** in the H1 and the **ICP + category** in the subhead.

### H2 structure (target one intent per section)
| Section | Current heading | Recommended SEO heading |
|---|---|---|
| How it works | *(no h2; steps are h4)* | `<h2>` **How Dryft works: predict, nudge, adapt — no budgeting required** |
| Final CTA | "get in first." | Keep (brand/conversion) |
| Team | "The Team." | Keep |
| Trust | "The boring stuff that matters." | ✅ now `Save money without budgeting, the boring stuff that matters.` |
| FAQ | "Questions." | Consider `Saving without budgeting: FAQ` for keyword pickup |

### Supporting section to add (ICP + keywords + conversion)
A short "Built for…" strip between How-it-works and CTA:
```html
<section class="built-for" id="who-its-for">
  <div class="section-wrap">
    <h2>Built for people who hate budgeting.</h2>
    <p>Dryft is for students and young professionals who know what they should do with money but
       struggle with the day-to-day. If you've tried budgeting apps, spreadsheets, and strict
       rules and still felt guilty and behind — this is the budgeting alternative that works
       with your real life, not against it.</p>
  </div>
</section>
```

**Conversion note:** keep the emotional hero payoff ("without thinking about it") and the waitlist CTA above the fold; SEO terms ride in the H1 fragment, subhead, and the new H2s — so you gain rankings without diluting the brand voice.

---

## 4. Content Marketing Strategy — 50-Article Roadmap

Funnel: TOF = awareness, MOF = consideration, BOF = decision. "Links" = recommended internal links
(P# = pillar in §5). Publish order ≈ table order (long-tail/ICP-pain first).

| # | Title | Primary keyword | Intent | Funnel | Internal links |
|---|------|------------------|--------|--------|----------------|
| 1 | Why Budgeting Fails for Most People (and What Works Instead) | why budgeting fails | Info | TOF | P-Budget, P-Save, /waitlist |
| 2 | How to Save Money Without Budgeting: A 5-Step Method | how to save money without budgeting | Info | TOF | P-Save, #1, /waitlist |
| 3 | Budgeting for People Who Hate Budgeting | budgeting for people who hate budgeting | Info | TOF | P-Budget, #2, /waitlist |
| 4 | How to Save Money Without Spreadsheets | save money without spreadsheets | Info | TOF | P-Save, #2 |
| 5 | The Psychology of Why You Overspend | why do i overspend | Info | TOF | P-Psych, #1 |
| 6 | How to Stop Feeling Guilty About Spending Money | guilt about spending money | Info | TOF | P-Psych, #5, /waitlist |
| 7 | Present Bias: Why "Future You" Always Loses | present bias spending | Info | TOF | P-Behavioral, #5 |
| 8 | How to Save Money in Your 20s Without a Strict Budget | save money in your 20s | Info | TOF | P-Save, /budgeting-for-students |
| 9 | What Is a Budgeting Alternative? 6 Ways to Manage Money Without Budgets | budgeting alternative | Commercial | MOF | P-Budget, #3 |
| 10 | AI Budgeting Apps Explained: How They Actually Work | ai budgeting app | Commercial | MOF | P-AI, /waitlist |
| 11 | Manual Expense Tracking Is Dead: Here's Why | expense tracking alternative | Info | TOF | P-Budget, #4 |
| 12 | How to Build Money Habits That Actually Stick | how to build money habits | Info | TOF | P-Habits, #5 |
| 13 | The Habit Loop, Applied to Spending | habit loop spending | Info | TOF | P-Habits, P-Psych |
| 14 | How to Save for an Emergency Fund Without Budgeting | emergency fund without budgeting | Info | MOF | P-Goals, calc(§6) |
| 15 | How to Save for a Trip While Keeping Your Lifestyle | save money for a trip | Info | MOF | P-Goals, calc |
| 16 | How to Save for a Car in Your 20s | save for a car | Info | MOF | P-Goals, calc |
| 17 | Spending Triggers: How to Spot Yours Without Tracking | spending triggers | Info | TOF | P-Psych, P-Habits |
| 18 | What Is Behavioral Finance? A Plain-English Guide | what is behavioral finance | Info | TOF | P-Behavioral |
| 19 | Loss Aversion and Why You Won't Cancel That Subscription | loss aversion money | Info | TOF | P-Behavioral, #20 |
| 20 | How to Cancel Subscriptions You Forgot You Had | cancel unused subscriptions | Info | MOF | P-Save, #19 |
| 21 | Why Strict Budgets Backfire (The Restriction Trap) | why strict budgets don't work | Info | TOF | P-Budget, #1 |
| 22 | YNAB vs Dryft: Zero-Based Budgeting vs Predictive Coaching | ynab alternative | Commercial | BOF | P-Budget, /waitlist |
| 23 | Rocket Money vs Dryft: Subscriptions vs Whole-Picture Saving | rocket money alternative | Commercial | BOF | P-Budget, /waitlist |
| 24 | Copilot Money vs Dryft: Tracking vs Predicting | copilot money alternative | Commercial | BOF | P-AI, /waitlist |
| 25 | Monarch Money vs Dryft: Dashboards vs Nudges | monarch money alternative | Commercial | BOF | P-AI, /waitlist |
| 26 | The Best Budgeting Apps for People Who Are "Bad With Money" | budgeting app bad with money | Commercial | MOF | P-Budget, #9 |
| 27 | How to Stop Overspending on Food Delivery | stop overspending on takeout | Info | TOF | P-Habits, #17 |
| 28 | Lifestyle Creep: How to Save More as You Earn More | lifestyle creep | Info | TOF | P-Save, P-Behavioral |
| 29 | How Much Should You Save Each Month in Your 20s? | how much to save in your 20s | Info | MOF | P-Goals, calc |
| 30 | Paycheck-to-Paycheck on a Good Salary: Why It Happens | living paycheck to paycheck | Info | TOF | P-Psych, #28 |
| 31 | What Is Spending Drift? (And How to Catch It Early) | spending drift | Info | TOF | P-AI, /waitlist |
| 32 | Nudge Theory in Personal Finance | nudge theory finance | Info | TOF | P-Behavioral, P-AI |
| 33 | How to Save Money on an Irregular Income | save money irregular income | Info | MOF | P-Save, P-Goals |
| 34 | Mental Accounting: Why You Treat $20 Differently | mental accounting | Info | TOF | P-Behavioral |
| 35 | The 50/30/20 Rule Is Broken — Here's a Flexible Alternative | 50/30/20 rule alternative | Info | MOF | P-Budget, #9 |
| 36 | How to Save Money Automatically (Without Forgetting) | save money automatically | Commercial | MOF | P-Save, P-AI |
| 37 | Sinking Funds Without the Spreadsheet | sinking funds | Info | MOF | P-Goals, #4 |
| 38 | How to Save for a House Down Payment in Your 20s | save for a down payment | Info | MOF | P-Goals, calc |
| 39 | Why You Self-Sabotage Your Savings Goals | self-sabotage savings | Info | TOF | P-Psych, P-Habits |
| 40 | Financial FOMO: Spending to Keep Up | financial fomo | Info | TOF | P-Psych, #28 |
| 41 | How AI Personal Finance Tools Predict Your Spending | ai personal finance | Commercial | MOF | P-AI, #31 |
| 42 | Open Banking & Plaid: Is It Safe to Connect Your Bank? | is plaid safe | Info | MOF | P-AI, /privacy |
| 43 | How to Save Money as a Student (Without Ramen Every Night) | how to save money as a student | Info | TOF | /budgeting-for-students, calc |
| 44 | The Best Money Apps for College Students | best money app for students | Commercial | MOF | /budgeting-for-students |
| 45 | How to Reach Financial Goals Without Tracking Every Dollar | reach financial goals | Info | MOF | P-Goals, /waitlist |
| 46 | Dopamine and Spending: The Brain Science of Impulse Buys | dopamine spending | Info | TOF | P-Behavioral, P-Psych |
| 47 | How to Build an Automatic Savings System | automatic savings system | Info | MOF | P-Save, P-AI |
| 48 | Anchoring: Why Sales Make You Spend More | anchoring bias shopping | Info | TOF | P-Behavioral, #20 |
| 49 | The Real Reason Money Apps Don't Change Your Behavior | money app behavior change | Info | TOF | P-AI, P-Behavioral |
| 50 | How to Save Money While Still Enjoying Your 20s | save money in your 20s lifestyle | Info | TOF | P-Save, #8 |

**Dryft's unique-perspective angles to over-index on** (defensible, hard for competitors to copy): spending *drift* prediction, the "day-9 intervention", guilt-free/anti-restriction framing, "right message at the right moment" behavioral nudges, and the no-tracking thesis.

---

## 5. Topical Authority Map

**Main topic:** Personal Finance → narrowed to **"managing money & saving without budgeting"** (the niche Dryft can actually own).

```
PERSONAL FINANCE (home / brand)
│
├── P-Budget  Pillar: /budgeting-alternatives  ("Budgeting Alternatives: Manage Money Without Budgets")
│     └ supports: #1 #3 #9 #11 #21 #22 #23 #26 #35
│
├── P-Save  Pillar: /save-money-without-budgeting  ("How to Save Money Without Budgeting")
│     └ supports: #2 #4 #8 #20 #28 #33 #36 #47 #50
│
├── P-Psych  Pillar: /spending-psychology  ("The Psychology of Spending")
│     └ supports: #5 #6 #17 #30 #39 #40 #46
│
├── P-Behavioral  Pillar: /behavioral-finance  ("Behavioral Finance, Explained")
│     └ supports: #7 #18 #19 #32 #34 #48 #49
│
├── P-Habits  Pillar: /money-habits  ("How to Build Money Habits That Stick")
│     └ supports: #12 #13 #27
│
├── P-Goals  Pillar: /financial-goals  ("Reach Financial Goals Without Tracking")
│     └ supports: #14 #15 #16 #29 #37 #38 #45 + goal calculators (§6)
│
├── P-AI  Pillar: /ai-budgeting-app  ("AI Budgeting App: How Dryft Works")
│     └ supports: #10 #24 #25 #31 #41 #42 #49
│
└── /budgeting-for-students (segment pillar) → #8 #43 #44
```

**Internal-linking rules**
1. Every cluster article links **up** to its pillar and **across** to 1–2 sibling articles.
2. Every pillar links **down** to all its cluster posts and **sideways** to 1–2 adjacent pillars.
3. Pillars link to **/waitlist** (the `#waitlist` CTA) with a benefit-led anchor ("join the Dryft waitlist").
4. Homepage links to the 3 priority pillars (P-Save, P-Budget, P-AI) from a footer "Learn" column.
5. Use descriptive anchors (the target keyword), never "click here".

---

## 6. Programmatic SEO Opportunities

Each is a template that generates many indexable, intent-matched pages from one build. All double as
lead-gen (gate the "personalized plan" behind the waitlist email).

| Opportunity | URL pattern | Search demand | Scalability | Conversion potential | Notes |
|---|---|---|---|---|---|
| **Savings goal calculators** | `/calculators/save-for-{goal}` (trip, car, emergency-fund, down-payment, wedding, laptop…) | High — "how much to save for X" has steady volume | High (1 template × dozens of goals) | **High** — natural CTA: "Let Dryft hit this goal for you" | Ship 10–15 goals first; each links to P-Goals |
| **"How long to save $X" calculator** | `/calculators/save-{amount}` | Med | High | High | Pairs with goal pages |
| **Spending personality quiz** | `/quiz/spending-personality` | Med (shareable) | Med (one quiz, many result pages) | **High** — result page → waitlist | Result archetypes = indexable + viral on TikTok/IG |
| **"What's your money type" / financial personality profiles** | `/money-type/{archetype}` | Med | High | High | Archetype pages (e.g. "The Impulse Spender") rank for the term + funnel to product |
| **Budgeting-style quiz** | `/quiz/budgeting-style` | Med | Med | High | "You're a "no-budget" type → meet Dryft" |
| **Savings challenge generator** | `/challenges/{type}` (52-week, no-spend, round-up…) | High seasonal (Jan) | High | Med–High | Seasonal traffic spikes; email capture to "track" the challenge |
| **City/segment cost pages** (later) | `/save-money-{segment}` (students, nurses, new grads) | Med | High | Med | Only after core clusters rank; avoid thin doorway pages |

**Guardrails:** every programmatic page needs unique, useful content (real calc + tailored copy), not a thin template — otherwise it's a doorway-page risk. Add `BreadcrumbList` + (for calculators) `WebApplication`/`HowTo` schema.

---

## 7. Structured Data — Recommendations + Production JSON-LD

**Already present & good** (`index.html:72-190`): `Organization`, `WebSite`, `SoftwareApplication` (+`offers`), `Service`, `FAQPage`. `/privacy` & `/terms` have `BreadcrumbList`.

**Add as you build:**

**(a) `WebSite` + `SearchAction`** (once `/blog` has search or even site: relevance) and **`sitelinks`-friendly nav** — minor.

**(b) `Article` / `BlogPosting`** — on every blog post:
```json
{
  "@context": "https://schema.org",
  "@type": "BlogPosting",
  "@id": "https://thedryft.com/blog/why-budgeting-fails/#article",
  "headline": "Why Budgeting Fails for Most People (and What Works Instead)",
  "description": "The behavioral reasons budgets break — and a no-budget way to save.",
  "image": "https://thedryft.com/blog/why-budgeting-fails/cover.png",
  "datePublished": "2026-06-10",
  "dateModified": "2026-06-10",
  "author": { "@type": "Organization", "@id": "https://thedryft.com/#organization" },
  "publisher": { "@id": "https://thedryft.com/#organization" },
  "mainEntityOfPage": "https://thedryft.com/blog/why-budgeting-fails/",
  "about": ["personal finance", "behavioral finance", "budgeting"]
}
```

**(c) `BreadcrumbList`** — on every blog post & programmatic page:
```json
{
  "@context": "https://schema.org",
  "@type": "BreadcrumbList",
  "itemListElement": [
    { "@type": "ListItem", "position": 1, "name": "Home", "item": "https://thedryft.com/" },
    { "@type": "ListItem", "position": 2, "name": "Blog", "item": "https://thedryft.com/blog" },
    { "@type": "ListItem", "position": 3, "name": "Why Budgeting Fails", "item": "https://thedryft.com/blog/why-budgeting-fails/" }
  ]
}
```

**(d) `HowTo`** — on method posts (e.g. #2 "How to save money without budgeting") and calculators:
```json
{
  "@context": "https://schema.org",
  "@type": "HowTo",
  "name": "How to Save Money Without Budgeting",
  "step": [
    { "@type": "HowToStep", "name": "Connect read-only", "text": "Link your accounts via Plaid; no manual entry." },
    { "@type": "HowToStep", "name": "Let it learn", "text": "Dryft learns your normal spending patterns." },
    { "@type": "HowToStep", "name": "Catch the drift", "text": "Get a nudge the moment you start to slip." }
  ]
}
```

**(e) `Review` / `aggregateRating`** — **gated**: add to `SoftwareApplication` only when you have genuine reviews. Faking this risks a manual action.
```json
"aggregateRating": {
  "@type": "AggregateRating",
  "ratingValue": "4.8",
  "ratingCount": "127"
}
```

**(f) `Organization.founder`** — now that the Team section is live, enrich the Organization node (also helps entity/E-E-A-T):
```json
"founder": [
  { "@type": "Person", "name": "Muqeeth Khan", "jobTitle": "Chief Executive Officer" },
  { "@type": "Person", "name": "Aman Zaveri", "jobTitle": "Chief Product Officer" },
  { "@type": "Person", "name": "Umair Sahi", "jobTitle": "Chief Technology Officer" },
  { "@type": "Person", "name": "Rinchen Kalsang", "jobTitle": "Founding Marketing Lead" }
],
"numberOfEmployees": { "@type": "QuantitativeValue", "value": 4 }
```
> Note: `sameAs` was corrected this pass to `instagram.com/thedryft.co` + `tiktok.com/@thedryft.com`.

---

## 8. Competitor Analysis

| | YNAB | Monarch Money | Rocket Money | Copilot Money | **Dryft (opportunity)** |
|---|---|---|---|---|---|
| Core promise | Zero-based budgeting, give every dollar a job | All-in-one dashboard / net worth | Find & cancel subscriptions, bill negotiation | Beautiful tracking + categorization | **Save without budgeting/tracking; predict drift & nudge** |
| Effort required | High (manual discipline) | Med (dashboards) | Low | Med (review transactions) | **Lowest (read-only, passive)** |
| Audience | Budgeting enthusiasts | Households/couples | Bill-cutters | Design-conscious trackers | **Students/young pros who hate budgeting** |

**Keyword gaps Dryft can win (low competition from these incumbents):**
- "save money **without budgeting** / **without tracking** / **without spreadsheets**" — incumbents target *pro-budgeting* queries; Dryft owns the **anti-budget** intent.
- "budgeting **for people who hate budgeting**", "budgeting **alternative**", "why budgeting **fails**".
- Behavioral terms: "spending drift", "present bias spending", "nudge theory finance", "guilt about spending" — almost no app competes here.
- Student terms: "budgeting for students", "best money app for college students" (YNAB has student discounts but weak content).

**Content gaps:**
- YNAB/Monarch lean into method/feature content; **behavioral-psychology** explainers are thin across all four → Dryft's §4/§5 behavioral clusters are wide open.
- None own the **"automation vs willpower"** narrative for the 18–35 ICP.

**Positioning opportunities / where Dryft wins organically:**
1. **Anti-budget category creation** — name and own "save without budgeting" / "budgeting alternative".
2. **Behavioral authority** — the psychology clusters build E-E-A-T no incumbent is contesting.
3. **Comparison BOF pages** (#22–26) — capture "{competitor} alternative" demand with an honest "tracking vs predicting" framing.
4. **Student wedge** — $3.99 + TikTok/IG distribution (@thedryft.co / @thedryft.com) → backlinks & branded search.

---

## 9. Immediate Wins (ranked)

**Quick wins — under 1 day** (impact / effort / time-to-result)
1. ✅ **Restore visible FAQ + align to `FAQPage` schema** — High / Low / 1–3 wks to rich result. *(done this pass)*
2. ✅ **SEO-optimize trust section copy + add ICP/keyword phrasing** — Med / Low / 2–4 wks. *(done)*
3. ✅ **Sitemap: add `/referral`, refresh `lastmod`** — Low / Low / days. *(done)*
4. ✅ **Correct `sameAs` Instagram handle** — Low / Low / immediate (entity accuracy). *(done)*
5. ◻️ **Rewrite title + meta to keyword-forward** (§3) — **High / Low / 2–6 wks**.
6. ◻️ **Add keyword H1 fragment + ICP subhead + `<h2>` on how-it-works** (§3) — High / Low / 2–6 wks.
7. ◻️ **Asset caching → immutable** (after versioning the 2 icon links) — Med / Low / next crawl. Snippet:
   ```jsonc
   // vercel.json — replace the /assets/(.*) Cache-Control
   { "key": "Cache-Control", "value": "public, max-age=31536000, immutable" }
   ```
   ```html
   <!-- index.html:45,47 — version the icons so immutable is safe -->
   <link rel="icon" type="image/png" sizes="96x96" href="/assets/icons/favicon-96.png?v=20260604">
   <link rel="apple-touch-icon" href="/assets/icons/apple-touch-icon.png?v=20260604">
   ```
8. ◻️ **Regenerate `og-image.png`** with current tagline; bump `?v=` — Med / Low / immediate social CTR.

**Medium effort — under 1 week**
9. ◻️ Add the **"Built for people who hate budgeting"** section (§3) — High / Med / 2–6 wks.
10. ◻️ Convert team + hero images to **WebP/AVIF** via `<picture>` — Med / Med / next CWV cycle.
11. ◻️ Stand up **`/blog`** (route, list page, post template w/ `BlogPosting`+`BreadcrumbList`) — High / Med / foundational.
12. ◻️ Publish the **3 priority pillars** (P-Save, P-Budget, P-AI) — High / Med / 4–12 wks.
13. ◻️ Add `Organization.founder` array (§7f) — Low / Low / entity/E-E-A-T.

**Long-term — 1–6 months**
14. ◻️ Publish the **50-article roadmap** (long-tail/ICP-pain first) — Very High / High / 2–6 mo.
15. ◻️ Build **programmatic calculators + quizzes** (§6) — High / High / 2–6 mo (also lead-gen).
16. ◻️ Earn **backlinks** via the behavioral-finance angle (HARO, student-finance partnerships, TikTok→branded search) — High / High / 3–6 mo.
17. ◻️ Add **`Review`/`aggregateRating`** once real reviews exist — Med / Low / when data exists.

---

## 10. Prioritized Action Plan

**Implement immediately (this week)** — *already shipped:* FAQ restore+align, trust SEO copy, sitemap, `sameAs` fix.
*Next, low-risk, highest leverage:*
1. Title + meta rewrite (§3) — biggest CTR/ranking lever for the effort.
2. H1 keyword fragment + ICP subhead + how-it-works `<h2>` (§3).
3. `vercel.json` immutable asset caching + version the 2 icon links (§9.7).
4. Regenerate `og-image.png`.

**Build next (2–4 weeks)**
5. `/blog` infrastructure with `BlogPosting` + `BreadcrumbList` templates (§7).
6. "Built for people who hate budgeting" homepage section (§3).
7. WebP/AVIF image pipeline (§9.10).
8. `Organization.founder` enrichment (§7f).

**Publish first (content order)**
9. Pillars in this order: **P-Save** (`/save-money-without-budgeting`) → **P-Budget** (`/budgeting-alternatives`) → **P-AI** (`/ai-budgeting-app`).
10. Then the Low-difficulty ICP long-tails: articles **#1, #2, #3, #6, #8, #21, #43** (these match the ICP's exact words and rank fastest on a new domain).
11. Then competitor BOF pages **#22–26** to capture "{competitor} alternative" demand.

**Highest-leverage opportunities (where to concentrate)**
- **Own the anti-budget category** — title/H1/pillars all say "save without budgeting"; no incumbent is defending it.
- **Behavioral-finance authority** — the §5 P-Psych/P-Behavioral clusters build E-E-A-T competitors are ignoring.
- **Programmatic goal calculators** — scalable rankings *and* the most natural waitlist conversion surface.
- **Student/young-pro distribution loop** — TikTok/IG (@thedryft.co / @thedryft.com) → branded search → backlinks → authority that lifts the whole domain.

---

### Appendix: changes applied in this pass
- `index.html`: restored + SEO-aligned visible FAQ (matches `FAQPage` JSON-LD); SEO/ICP-optimized Trust & clarity copy (`No tracking` / `No guilt` categories, "save money without budgeting" H2); corrected `sameAs` Instagram handle; (earlier) title/meta refreshed to current positioning, team section + social links.
- `sitemap.xml`: added `/referral`, refreshed all `lastmod` to 2026-06-04.
- Team photos: re-cropped to centered, head-and-shoulders squares.

### Appendix: changes applied in pass 2 (2026-06-04)
Scope: apply generic/technical SEO without changing visible UX/wording, except Trust & FAQ.
- **Title + meta rewrite** (§3, §9.5): keyword-forward, brand-neutral. Per direction, dropped "AI" and used **"without strict budgeting"** (not "without budgeting"); no em dashes. New title `Save Money Without Strict Budgeting | Dryft Money App`; new meta description leads with category + ICP + benefit + CTA. Mirrored to `og:title`/`og:description`/`twitter:title`/`twitter:description`. Cleaned "AI" out of the `keywords` meta and refreshed it toward the strict-budgeting / budgeting-alternative cluster.
- **Asset caching → immutable** (§6, §9.7): `vercel.json` `/assets/(.*)` is now `public, max-age=31536000, immutable`. Versioned the two previously-unversioned icon links (`favicon-96.png`, `apple-touch-icon.png`) with `?v=20260604` so immutable is safe. (Self-hosted fonts left unversioned — static binaries, safe under immutable.)
- **Heading hierarchy** (§1 #10): added a visually-hidden `<h2 class="sr-only">` to the how-it-works `section` ("How Dryft works: predict, nudge, and adapt without strict budgeting") — fixes the h1→h4 jump for crawlers/SR without touching the visible design.
- **`Organization.founder` + `numberOfEmployees`** (§7f): added the 4-founder array and employee count to the Organization JSON-LD node.
- **Images → AVIF** (§1 #7): converted the 4 team photos (~1 MB PNG each) to AVIF (37–72 KB, ~95% smaller) via `sips` (q72); each `<img>` now sits in a `<picture>` with the AVIF `source` + original PNG fallback. Added `.team-photo picture { display:block; width:100%; height:100% }` so the wrapper fills the same box (no visual change). Verified in-browser: browsers load the AVIF, faces are artifact-free, layout/hover intact. *(WebP not used: `sips` on this machine can write AVIF but not WebP; AVIF has broader compression and universal modern-browser support with the PNG fallback.)*
- **Trust section** (allowed to change): H2 updated to "Save money without **strict** budgeting, the boring stuff that matters."
- **`og-image.png` regenerated** (§1 #8, §9.8): replaced the stale 1200×630 share image with one matching the current hero style (ocean/misty background, brand lockup, "private beta 01" badge, "become better at money, without thinking about it." in real Inter Tight, "keep on track…" subhead). Built from an HTML template rendered via headless Chrome at 2× and downscaled to 1200×630 for crisp type. Bumped the version token to `?v=20260604` on `og:image`/`og:image:secure_url`/`twitter:image` across `index.html`, and on the shared image refs in `privacy.html` + `terms.html`. `og:image:alt` already matched.

*Still not applied (visible-wording or out-of-scope):* H1/hero subhead keyword edits, "Built for people who hate budgeting" section, `/blog` + content engine, programmatic calculators/quizzes, `Review`/`aggregateRating` (gated on real reviews). Hero `background.jpg` (215 KB, the LCP) left as JPG to avoid any LCP quality regression.

### Appendix: changes applied in pass 1
*Not yet applied (await go-ahead):* title/meta keyword rewrite, H1/hero edits, `vercel.json` caching, `og-image.png` regen, WebP pipeline, `/blog`, content.
