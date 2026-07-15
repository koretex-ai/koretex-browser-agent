# CLAUDE.md

Guidance for AI coding assistants working in `extension/`.

## Project

Chrome MV3 side-panel extension for **Local Browser Use** — a vision-native browser agent that runs fully locally via Ollama. Forked from Nanobrowser but stripped to the shell: the multi-agent core, browser automation, and multi-provider LLM config were deleted. The agent core is rebuilt fresh phase by phase (see `../DESIGN.md`).

Current state: PLAN–ACT–VERIFY (PAV) architecture — perception (shadow-DOM-aware set-of-marks + screenshots), typed executor, Holo1.5-3B vision grounding, qwen2.5vl:3b visual verification, trajectory logging, cloud planner/reflector (GLM 5.2). A legacy fully-local Planner→Executor→Validator loop remains ONLY for the no-API-key case (`runLocalTask` in `agent/loop.ts`).

TWO CLOUD ENGINES, switched by the `CLOUD_ENGINE` constant in `agent/loop.ts` (currently 'stepwise' — an experiment being benched against 'pav'):

- STEPWISE (`agent/stepwise.ts`, prompts NEXT + REVIEW in orchestrator.ts): JUDGE-AND-DECIDE, one MULTIMODAL cloud call per step (`navigatorModel`, default xiaomi/mimo-v2.5). Loop: capture screenshot + digest → the navigator JUDGES what the last action actually did (assessment + succeeded/failed/uncertain, from pixels) and DECIDES the next step → runtime executes → settle (per-action-type delay so the page reacts before it is photographed) → repeat until the navigator can SEE the objective delivered. NO planner-authored expects and no separate verifier — verification IS the judgment at the top of each turn. STRATEGIC REVIEW tier: the per-step loop is deliberately myopic; deterministic stuck signals (same action judged failed twice, 2 consecutive failed judgments, a guard rejection, or the navigator flagging "stuck": true) trigger ONE deep call — same navigator model with reasoning ON — that diagnoses the root cause (e.g. a paywalled control that keeps reverting) and sets an ACTIVE STRATEGY, pinned into every subsequent turn until superseded. Review verdicts: strategy | done | blocked; max 3 reviews/run; a review repeating its predecessor's strategy stops the run honestly. Budgets: wall clock 15 min is the working budget (navigator is told TIME REMAINING; MAX_STEPS=150 is only a runaway backstop), 4 consecutive judged failures, 3 CONSECUTIVE invalid decisions (any executed step resets). In-code guards: side-effect steps get one attempt; a side-effect judged failed/uncertain can never be re-issued on the same page (permanent per-run memory); an action judged failed twice is rejected at decision time and escalates to review; submit-looking click/key targets must declare sideEffect explicitly (input-looking targets exempt).
- PAV (`agent/pav.ts`): one cloud model makes every decision through PLAN (objective + journal + page digest → complete typed program, max 25 steps, each state-changing step carrying an `expect` postcondition + 1-4 objective-level expects), REFLECT (failed step + verifier observation → fix_step | replan | stop). The CONDUCTOR is a deterministic state machine — inner loop: execute step → verify expect → pass: next / fail: one silent retry, then REFLECT; outer loop: all steps passed → verify objective expects → achieved: REPORT / not: PLAN again with the journal, until MAX_PLANS (5) or the 15-min wall clock dies.

Both engines share REPORT (final answer; doubles as salvage) and CURATE (collection quality pass). Local models are senses only: label matching + Holo grounding resolve click targets, qwen3.5:4b reads pages (extract/harvest), `verifierModel` (qwen2.5vl:3b) answers visual questions.

VERIFICATION (`agent/verifier.ts`): expects are tiered — `url` reads the tab itself (instant, no content script); `text`/`element`/`gone` are deterministic checks POLLED (~8s) against fresh perception (verification doubles as the wait-for-settle primitive; plans need no wait steps). A `text` expect matches page text OR element labels/placeholders (independent senses — heavy SPAs can return empty page text while the element digest is fine). `see` is one local-VLM screenshot question for canvas editors/visual outcomes. VISION ESCALATION (house rule: an uncertain sense escalates to a stronger sense, never concludes from blindness): when the deterministic senses were BLIND — no read at all, or empty page text for a text check, or an empty element digest for an element check — the verifier asks the local VLM one screenshot question derived from the expect before failing; vision only breaks ties where the alternative was certain failure. Conservative otherwise: uncertain = fail. Failures return a precise observation of what the page actually shows, including the underlying perception error when reads failed.

SAFETY IN CODE, NOT PROMPTS: steps tagged `sideEffect: true` (post/send/submit/purchase/delete) get exactly ONE attempt — never auto-retried; a reflect "fix" that repeats a failed side-effect action is rejected by the conductor. Loop guards: a fixed step that fails again forces replan; a plan whose action skeleton fingerprints identical to a failed plan gets one warning, then the run stops honestly. Plans without expects on state-changing steps are rejected by the conductor before execution.

DATA: the JOURNAL is one capped (~80 lines) append-only history fed identically to every cloud call — facts, step outcomes ✓/✗ with observations, reflect verdicts, data digests. The COLLECTION STORE keeps every extract's list lines deduped and UNTRUNCATED; write steps use `textFrom:"collected"` and the harness inserts all items verbatim at execution time (collected datasets never round-trip through the cloud). Harvest queries for data destined to be written must ask for items pre-formatted for the destination.

RESUME + CLARIFY + TIMEOUT: every cloud call goes through `background/net.ts` fetchWithTimeout (90s cap) so a stalled connection becomes a clean error, not a forever-spinner. PAV persists its knowledge (`runStateStore`, `packages/storage/lib/runstate/`) — objective + journal + collection + status — keyed by sessionId, after every plan and every verified step. On a stall/cancel/budget end the state is left status='stalled'; the next message on that session, if it is a CONTINUATION phrase ("continue"/"resume"/...), seeds the journal+collection and re-plans against the LIVE page (knowledge-replay, not step-replay — the stale page is re-observed). A delivered task clears its state; an unrelated new message discards the stale run. CLARIFY: PLAN may return mode "clarify" with 1-3 questions when the objective is genuinely ambiguous (first plan only); the conductor posts them, persists status='awaiting_clarification', and ends the turn — the user's next message is folded in as the answer and planning resumes. Prompt principle: ask ONLY when no reasonable default exists, else assume + note + proceed.

PRIVACY DOCTRINE (amended 2026-07-15, user decision — robustness first): the STEPWISE navigator sends tab SCREENSHOTS to the remote model; every orchestrator call requests no-retention routing (OpenRouter `provider: {data_collection: "deny"}`). Grounding (click coordinates) stays local. The PAV engine and the no-API-key local loop remain fully local — screenshots never leave the machine on those paths. Cloud payloads otherwise are digest-only: objective, journal, page digests (URL/title/element labels/text sample). Benchmark: `../bench/consistency/PROTOCOL.md`.

RECIPES (deprioritized, storage only): `packages/storage/lib/recipes/` remains but nothing wires it into the run loop — revive from git history (`agent/recipes.ts` deleted at the PAV rewrite) when basics are consistent.

## Commands

Always use `pnpm` (v9, via corepack) with Node ≥ 22.12 (`nvm use v22.13.0`).

- `pnpm install` — install deps
- `pnpm build` — production build to `dist/`
- `pnpm dev` — watch mode with HMR
- `pnpm type-check` / `pnpm lint` / `pnpm prettier` — checks
- Workspace-scoped: `pnpm -F chrome-extension build`, `pnpm -F pages/side-panel type-check`, etc.

Load the extension: `chrome://extensions` → Developer mode → Load unpacked → `dist/`.

## Architecture

Turbo + pnpm monorepo:

- `chrome-extension/src/background/index.ts` — service worker: routes side-panel port messages (`new_task`, `follow_up_task`, `command`, `cancel_task`, `heartbeat`).
- `chrome-extension/src/background/agent/` — `loop.ts` (runAgentTask entry: routes to PAV or local-only; runSubtask legacy local loop), `pav.ts` (plan–act–verify conductor), `orchestrator.ts` (PLAN/REFLECT/REPORT cloud calls, digest-only), `verifier.ts` (tiered expect verification), `program.ts` (deterministic step engine, createStepRunner), `planner.ts` (local JSON-mode action selection + extract reader), `grounder.ts` (Holo grounding + verifyVisual), `chat.ts` (streaming chat), `prompts.ts`.
- `chrome-extension/src/background/actions/cdp.ts` — CDP escape hatch (Phase 6): trusted keyboard input via chrome.debugger for canvas editors (Google Docs/Sheets) that ignore synthetic events. KEYBOARD ONLY by design — CDP mouse is avoided because the debugger infobar reflows the viewport and would shift grounder coordinates. `type_focused` action is CDP-only; `key` is CDP-first with synthetic fallback. Attach lazily, stay attached (stable geometry), detach at task end.
- `chrome-extension/src/background/perception/` — set-of-marks extraction (innermost-interactive dedupe, open shadow roots) + downscaled screenshots. Invariant: ONE extraction per step; executor never re-perceives (see executor.ts).
- `pages/side-panel/` — React chat UI. Connects via `chrome.runtime.connect({name: 'side-panel-connection'})`. Receives `execution` events (task.start/ok/fail/cancel), `stream_chunk` deltas, and `error`.
- `pages/options/` — settings page backed by `chatSettingsStore` (Ollama base URL + model; defaults `http://localhost:11434` / `qwen3.5:4b`).
- `packages/storage` — chrome.storage wrappers: `chatHistoryStore` (sessions/messages), `chatSettingsStore`, favorites. `Actors` = system | user | assistant.
- `packages/{ui,i18n,shared,vite-config,tailwind-config,tsconfig,hmr,dev-utils,zipper}` — tooling kept from upstream.

Message/actor types double as the future training-label schema — keep them typed and stable.

## Conventions

- Prettier: 2 spaces, single quotes, semicolons, printWidth 120. ESLint with `@typescript-eslint/consistent-type-imports`.
- Components `PascalCase`, variables `camelCase`, workspace dirs `kebab-case`.
- i18n: source locale is `packages/i18n/locales/en/messages.json`; never edit generated `packages/i18n/lib/**` or `dist/**`.
- Run `pnpm type-check` before committing.
- Keep extension permissions minimal (currently: storage, tabs, activeTab, scripting, unlimitedStorage, sidePanel, debugger — the last is the CDP escape hatch for trusted input; host permissions: <all_urls> for perception/actions + localhost Ollama).
