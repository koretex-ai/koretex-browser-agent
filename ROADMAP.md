# Koretex Lead Engine — Roadmap

Full "search leads + follow up" solution built on two repos:
- **Extension** (`koretex-browser-agent`): the browser agent — premium data-collection tier (logged-in sites, bot-hostile sites, unknown sites) + recipe generator.
- **Website** (`koretex-24-jul`, Next.js): user accounts, master lead DB, dashboard tables, server-side scraping workers, sequencer.

## Core architecture decisions (settled 2026-07-26)

1. **Master lead DB is a shared cache with freshness semantics.** Every user's search feeds it; subsequent searches serve from it when fresh, re-fetch only stale/missing attributes. This is the compounding moat.
2. **Entities + observations, not result rows.** `Company` (canonical key: domain, fallback Maps place ID) and `Person` (canonical key: LinkedIn URL / email). Facts stored as observations with `source`, `observedAt`, `confidence` — append-only, resolver picks freshest/trusted. Per-attribute TTLs (hiring signal ~2wk, email ~90d, firmographics ~1yr).
3. **Two scores:** *fit* (per-query, judge model at query time) and *heat* (global buying signals, computed at ingest, decays). Never collapsed into one.
4. **Tiered execution router** — always the cheapest tier that works:
   1. Master DB (fresh) → instant
   2. Server HTTP fetch → public server-rendered pages
   3. Server headless (Playwright + recipe) → public JS-heavy sites
   4. Extension background-tab recipe (no LLM) → gated / bot-hostile sites (Google Maps, LinkedIn) with known recipe
   5. Extension full agent loop → unknown sites / broken recipes; successful runs distill into recipes for tiers 3–4
5. **No lead-data vendors.** Company discovery, people (via LinkedIn/team pages), and work emails (scrape → pattern inference → SMTP verify, ~70–85% coverage) done in-house. Known gap: personal mobile numbers — impossible without vendors; business phones come from Maps. If ever needed, a vendor becomes an optional paid enrichment flag, not a foundation.
6. **Outreach sends through the user's own Gmail/Workspace (OAuth)** — never our own mail infra (deliverability). LinkedIn touches via extension with strict daily caps.
7. **Query compiler:** user prompt → structured ICP filters (industry, geo, headcount, signal type), stored structured so DB coverage is computable.

## Source catalog (vendor-free)

| Source | Yields | Tier |
|---|---|---|
| Google Maps | local businesses: name, phone, site, rating | extension (Google blocks datacenter IPs) |
| ATS boards (Greenhouse/Lever/Ashby) | hiring signals — public JSON, near-free | server |
| Company websites | emails, team pages, tech stack | server |
| Shopify/Woo stores | e-comm leads (public product feeds) | server |
| Registries (EDGAR, Companies House) | legal existence, officers | server (free APIs) |
| News / YC & accelerator directories | funding events (heat) | server |
| GitHub | dev-tool ICPs | server (free API) |
| LinkedIn | people, titles, activity signals | extension only |
| X/Twitter, Reddit | intent signals | extension mostly |

---

## Phase 0 — Foundation
> Milestone: a search in the extension shows up as a live table on the website.

- [x] Prisma schema: `ResearchRun`, `ResearchRow`, `Company`, `Observation` (migration `20260726031331_lead_engine_runs`; Person/SavedQuery deferred to Phase 1)
- [x] Extension ↔ website account link: site `/connect-extension` page + `POST /api/extension/token` (180-day JWT) + extension `accountStore` + options Account tab (paste code, validates via `/api/users/me`) — USER-VALIDATED 2026-07-26
- [x] API: POST/GET `/api/runs`, GET/PATCH/DELETE `/api/runs/[id]`, POST `/api/runs/[id]/rows` (batched idempotent upsert) — curl-verified 2026-07-26; dev helper `scripts/dev-mint-token.mjs`
- [x] Extension sync module (`background/sync.ts`): creates run at task start (clientRunId = taskId), 4s diff-flush of rows/collection, honest end status (COMPLETED/FAILED/STOPPED; clarification keeps RUNNING); hooked into stepwise.ts; purely additive — USER-VALIDATED 2026-07-26 (connect + live sync; cancel path untested)
- [x] Dashboard: `/dashboard/runs` list + `/dashboard/runs/[id]` table (sort, CSV export, 4s polling while RUNNING, failed/stopped banners) — browser-verified 2026-07-26
- [x] M5 download page: `ExtensionRelease` model + `npm run release:extension` (zips extension dist → Hetzner `extension-releases/`, keeps newest 3 zips, prunes older + stamps prunedAt) + public `/download` page (latest + previous versions + load-unpacked instructions) — v0.1.1 published & verified 2026-07-26

## V1 — Mine my own LinkedIn network (current priority, set 2026-07-26)
> The wedge: 5,000 first-degree connections behind the user's login that Apollo/Clay/Origami structurally cannot see. Goal: ranked top 100 with why-now + how-I-know-them.
> Design: one agent, human-paced, resumable, no swarm. State = queue + done-set + table.

### Pass 0 — seed (no browsing)
- [ ] Ingest LinkedIn data export (`Connections.csv`: name, title, company, profile URL, connected-on)
- [ ] NOTE: the archive also contains `messages.csv` (full DM history) — this may deliver Pass 3 "how you know them" for ALL contacts with zero browsing; check when the export lands

### Pass 1 — classify (no browsing) — BUILT 2026-07-26
- [x] Schema: `ContactImport` + `Contact` with 12 rich tags (archetype, seniority, functionalArea, companyType, companySize, industry, buyingPower, doesOutbound, icpFit 0-100, confidence, companyKnown, reason) + `tags` Json for future additions without migration
- [x] `lib/linkedin-csv.ts`: RFC4180 parser that skips LinkedIn's pre-header notes lines; `companyKeyOf` normalizes "Google LLC" → google
- [x] `lib/contact-classify.ts`: LLM-FIRST over UNIQUE title+company pairs (60/batch, 3 concurrent, OpenRouter structured outputs); blank rows tagged in code without a call; keyword rules are the FALLBACK when a batch fails. PRIVACY: only "position | company" is sent — never names. (Rules-first was tried and reverted 2026-07-26: it short-circuited the model on founders/recruiters — the highest-value rows — losing companyType/industry. Live proof: "Founder @ Cedar Recruitment Group" scored 80/unknown under rules-first vs 95/staffing_recruiting under LLM-first.)
- [x] Credits: min 25, charged on completion only, admins free (`contactImportCost`). **PRICE UNDER REVIEW — see measured economics below**
- [x] MEASURED 2026-07-26 (deepseek-v4-pro via OpenRouter, live pricing $0.435/M in, $0.87/M out):
  - **CORRECTNESS BUG FOUND + FIXED**: with reasoning ON, a 60-row batch spent its entire 8k token budget on reasoning and returned ZERO results (cost $0.011 for nothing). Only caught because a full-size batch was finally tested — earlier tests used 8-12 rows. Fix: `reasoning: {enabled: false}`, which is also cheaper and correct.
  - Latency is the batch-size lever, not cost: 60 rows = 227s, 25 rows = 67s; cost/contact flat at ~$0.00034-0.00036. Settled on BATCH_SIZE 25 + CONCURRENCY 8 (was 60/3) → ~20 min for 5,000 contacts instead of ~75.
  - Real cost for 5,000 contacts: **$1.26-1.80** (depending on unique title+company pair ratio).
  - At the old 5 coins/100 (250 coins) that is 1.0-1.4x cost on the Agency bundle ($500/70k coins) — i.e. break-even or a LOSS. Recommendation on the table: 15 coins/100 → 3.0-4.3x margin across all bundles.
  - `ContactImport.costUsd` now records real spend per import so pricing stays evidence-based.
- [x] Master-DB feed: each distinct employer upserts a `Company` + `Observation`s (company_type, industry, size, known_connections). Company-level only — person data stays in the user's own rows
- [x] Page `/dashboard/network` (nav tab "My Network"): upload, live progress, stat tiles, warm-accounts (companies where several connections cluster), filters, CSV export; `PATCH /api/contacts/[id]` for hand-corrections (editedByUser protects them from re-runs)
- [x] Resilience: a dead batch never fails the whole import (rows stay unclassified); `POST /api/contacts/import/[id]/retry` re-runs only what is missing; `coinsCharged` guard prevents double-charging on retry
- [ ] AWAITING: real Connections.csv to measure blank rate + unknown-company rate; user hand-labels 100 rows to validate
- [ ] LATER: for contacts where `companyKnown` is false AND the title is promising, one cheap homepage fetch per COMPANY (not per person) to fill industry/size — first use of the server-side fetch tier

### Pass 2 — continuous worker (the real build)
**Architecture decided 2026-07-27: extension = HANDS ONLY, brain on the server.** The worker captures profile page text and posts it to the site; the server runs the model call and stores results. Keeps the API key server-side, cost tracking in one place, and the extension dumb enough to be reliable. Same logic generalises: with a server brain + credits, users never need their own OpenRouter key.
Agreed with user: stay VISIBLE when viewing profiles; worker owns its OWN pinned LinkedIn tab (not the user's); "did they engage with MY content" deferred to Pass 3 / messages.csv.

- [x] STEP 1 DONE (server side, 7f16bb5): Contact Pass-2 fields; ContactVisitStatus queue/done-set with expiring leases; VisitDay (durable daily cap + halt); buildQueue (ICP fit + recency, first 50 interleaved across archetypes, students/retirees/no-URL skipped); `POST/GET /api/pass2/next`, `POST /api/pass2/capture` (scores to timingScore/whyNow/bestHook), `POST /api/pass2/halt`. Short captures requeue rather than burn the contact. Verified end to end.
- [x] STEP 2: extension worker, MANUAL mode — "Run one sitting" button, capture + submit. USER-VALIDATED 2026-07-27 (3 profiles read end-to-end: locations captured, scored, charged).
- [x] STEP 3: pacing engine BUILT 2026-07-27 (v0.1.3, `background/autopilot.ts`): chrome.alarms-driven sittings of 8-15, 15-45 min jittered breaks, active hours 9:00-21:00 + up to 90 min start jitter, day-over on halt/empty queue/cap/no coins, self-disables on dead account link; dashboard toggle on Prospects page. Ramp raised same day: 50→100→150→200, hard cap 300 (env-tunable). USER TEST GATE: turn on autopilot, leave the browser open a day.
- [ ] STEP 4: "Top 100" view on the site (ranked, why-now, hook) + progress card
- [ ] Agreed pacing: warmup 25/day → 50 → plateau 80/day, hard cap 100; sittings of 8-15 profiles then 15-45min breaks; 20-60s dwell per profile; randomize everything; active hours only
- [ ] Kill-switches: any CAPTCHA/checkpoint/warning/logout → stop for the day; 2 anomalies in a week → halve the cap
- [ ] Capture per profile: current role, company size, title still current, posts in last 30 days, engagement with user's content
- [ ] Resumable + idempotent (queue/done-set persist; tab close = clean stop)
- [ ] OPEN DECISION: visible vs private profile viewing (recommendation: stay visible — reciprocal views are a free warm touch)

### Pass 3 — relationship archaeology (top 100)
- [ ] Prior DM history + shared context → the "how you know them" line
- [ ] Cap 20-25 threads/day. May be obsoleted by `messages.csv` from the export (see Pass 0)

## Phase 1 — Search MVP (vendor-free discovery)
> Milestone: "Series A companies in Austin hiring SDRs" returns a real deduped table; repeat search answers instantly from DB.

- [ ] Query compiler: prompt → structured ICP filters, persisted
- [ ] Router v1: DB-coverage check first, live search only for gaps/stale
- [ ] Source: Google Maps via extension (background-tab or agent)
- [ ] Source: ATS job boards server-side (Greenhouse/Lever/Ashby public JSON)
- [ ] Source: company websites server-side (fetch + parse)
- [ ] Entity resolution / dedup on ingest (domain as primary key; accept 80%)

## Phase 2 — Enrichment & scoring
> Milestone: lead table with verified emails and pass/fail qualification — Origami's core loop, no vendors.

- [ ] Enrichment columns: column spec → per-row fan-out job through the router (`enrich(collection, columnSpec)` primitive)
- [ ] Email engine: site scrape → pattern inference (first.last@) → MX/SMTP verification (needs small VPS with clean IPs, port 25; catch-all detection)
- [ ] Tech-stack detection from HTML (Wappalyzer-style, in-house)
- [ ] Fit score: per-query judge pass/fail/unsure column
- [ ] Heat score: funding/hiring/activity signals at ingest, time-decay

## Phase 3 — Scale the cheap tiers
> Milestone: searches complete mostly server-side; extension only for LinkedIn/Maps; DB grows without users present.

- [ ] Worker service + job queue (Playwright pool) on our infra
- [ ] Recipe format + distillation: successful agent trajectory → deterministic recipe (URLs, selectors, pagination); shared store, executable by server AND extension
- [ ] Extension background-tab recipe executor (no LLM, user's IP/cookies)
- [ ] Residential proxy integration for hostile-but-public sources
- [ ] Nightly freshness worker: re-check near-expiry attributes on leads in active lists
- [ ] Central per-domain rate limiting across all workers

## Phase 4 — Follow-up (sequencer)
> Milestone: find → qualify → sequence → reply in one surface.

- [ ] Gmail/Workspace OAuth send (user's own account; CAN-SPAM/unsubscribe handling)
- [ ] Sequence engine: multi-step campaigns (email d0 → follow-up d3 → LinkedIn d7), stop-on-reply
- [ ] LinkedIn touches via extension, strict daily caps
- [ ] Reply detection (Gmail API)
- [ ] CRM push (HubSpot/Salesforce) + CSV export
- [ ] BLOCKER: extension sideEffect reject-deadlock bug must be fixed before any send-capable flows

## Ongoing / risks

- Compliance: pooled *company* data fine; pooled *personal* contact data = GDPR/CCPA controller obligations (removal mechanism needed before pooling emails/phones across users)
- Hard part #1: entity resolution (endless; domain-key gets 80%)
- Hard part #2: SMTP verification ops (port 25, clean IPs, catch-alls)
- Standing rule: no regression to working extension surfaces — cross-surface smoke test after effector changes
