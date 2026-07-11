# CLAUDE.md

Guidance for AI coding assistants working in `extension/`.

## Project

Chrome MV3 side-panel extension for **Local Browser Use** — a vision-native browser agent that runs fully locally via Ollama. Forked from Nanobrowser but stripped to the shell: the multi-agent core, browser automation, and multi-provider LLM config were deleted. The agent core is rebuilt fresh phase by phase (see `../DESIGN.md`).

Current state: full agent — perception (shadow-DOM-aware set-of-marks + screenshots), typed executor, Planner→Executor→Validator loop on local models, Holo1.5-3B vision-grounding fallback, trajectory logging, and an optional cloud orchestrator (hybrid mode).

Hybrid mode: a strong cloud model (OpenAI-compatible endpoint, default OpenRouter + GLM-5.2) triages each task, decomposes multi-part tasks into subtasks, checkpoints after each, and writes the final answer. Local models execute all browser actions. HARD RULE: orchestrator payloads are digest-only — screenshots and raw element lists never leave the machine (see `agent/orchestrator.ts`). No API key → fully local behavior.

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
- `chrome-extension/src/background/agent/` — `loop.ts` (runAgentTask: hybrid orchestrated flow or local-only; runSubtask inner loop), `orchestrator.ts` (cloud triage/checkpoint, digest-only), `planner.ts` (local JSON-mode action selection), `grounder.ts` (Holo vision fallback), `chat.ts` (streaming chat), `prompts.ts`.
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
- Keep extension permissions minimal (currently: storage, tabs, activeTab, unlimitedStorage, sidePanel; host permissions only for localhost Ollama).
