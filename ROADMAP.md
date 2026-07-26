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
