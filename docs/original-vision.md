> **Historical document** — the original fully-local design vision (July 2026, pre-implementation).
> The architecture has since evolved: perception and grounding remain local, but decisions moved
> to a cloud navigator after live runs showed reliability demanded it. The current architecture
> is described in the [root README](../README.md).

# local-browser-use

**A vision-native AI agent that lives in your browser sidebar, runs entirely on a local model, and performs web tasks in your real, logged-in session.**

Chat with a local model (served via Ollama on your own Mac) and have it *see* your screen and *act* on your behalf — click, type, navigate — inside the browser you already use, with the tabs you're already logged into. No cloud, no credentials handed to a third party, no separate automated browser.

Think Claude Cowork / Operator-style browsing, but **local-first, vision-native, and built from first principles.**

> **Status:** Design + feasibility-spike complete. Phase 0 proved a local 3B vision model can ground and click on real web UI on an 18GB Mac. Implementation (Phase 1+) is next. See [DESIGN.md](DESIGN.md) and [phase0/RESULTS.md](phase0/RESULTS.md).

---

## Why build this from first principles?

There are already capable open-source browser agents. We're not cloning them, for three reasons:

1. **Vision-native, not vision-bolted-on.** Most existing extensions were architected around *text* LLMs reading the DOM, with vision added awkwardly later. Purpose-built, small, open **vision-grounding** models for the web now exist (they didn't a year ago) — so the agent can be designed around *seeing* the page from day one.
2. **Local-first economics.** Capable models now fit on consumer Apple Silicon. A vision grounder at 3B runs comfortably on an 18GB Mac. The whole loop can be private and free at the point of use.
3. **A data flywheel.** Every interaction — screenshot, chosen action, outcome, and especially *human corrections* — is exactly the data used to train the next generation of grounding models. We design the data schema for that from the first commit, so usage compounds into a better model.

## How it works

The agent core is a set of **decoupled modules behind clean interfaces**, so any model or strategy can be swapped without rewriting the loop:

```
┌──────────────────────────────────────────────────────────────┐
│  Your real browser (logged-in session)                        │
│  ┌────────────┐         ┌──────────────────────────────────┐  │
│  │ Active tab │◄───────►│  Side Panel  — chat · steps ·     │  │
│  └─────┬──────┘ act+obs │  approve / correct controls       │  │
│        │                └───────────────┬──────────────────┘  │
│  ┌─────▼─────────────────────────────────▼─────────────────┐  │
│  │  AGENT CORE                                              │  │
│  │  Perception → Planner → Grounder → Executor → Validator  │  │
│  │                  ▲                      │                │  │
│  │                  └─────── loop ─────────┘                │  │
│  │  Trajectory Logger (taps every stage → training data)    │  │
│  └────────────────┬───────────────────────┬────────────────┘  │
└───────────────────┼───────────────────────┼───────────────────┘
            ┌────────▼────────┐     ┌────────▼─────────┐
            │ Local model      │     │ Local data store  │
            │ runtime (Ollama) │     │ (trajectories,    │
            │ vision grounder  │     │  corrections)     │
            │ + text planner   │     └───────────────────┘
            └──────────────────┘
```

- **Perception** builds an observation of the page — DOM / accessibility tree *and* a downscaled screenshot.
- **Planner** (text model) decides the next high-level action from the task + history.
- **Grounder** (vision model) maps "click the Search button" → an actual element / pixel.
- **Executor** performs the action in the page.
- **Validator** checks it worked, and drives retry / replan / ask-the-human.
- **Trajectory Logger** records every step as training-ready data.

## Key design choices

| Decision | Choice | Why |
|---|---|---|
| **Perception** | **Hybrid** — DOM / set-of-marks by default, pixel-vision fallback | DOM is fast and reliable where it works; vision covers what it can't (canvas, custom widgets, iframes). Capturing **both** per action makes the data a *superset* — you can train a pure-vision model later from hybrid-collected trajectories. |
| **Default grounder** | **Holo1.5-3B** (web-specialized VLM, Apache-2.0) | Purpose-built for web UI localization, fits 18GB with headroom, and is fine-tunable (Qwen2.5-VL backbone — the same base our future training would use). |
| **Planner** | Small local **text** model, swappable | Pure-text reasoning; can run locally or be dispatched to our local inference network. |
| **Shell** | Fork an existing MV3 extension for the **side panel + plumbing only** | Don't reinvent Chrome-extension boilerplate; build the agent core fresh where the real value is. |
| **Reference architecture** | Surfer-H + Holo1 (policy / localizer / validator split) | A proven, vision-native blueprint that maps cleanly onto swappable models. |
| **Cross-cutting** | Typed action space **==** training-label schema; log trajectories + human corrections from commit #1 | The data flywheel only works if the schema is right from the start. |

### Models considered

- **Holo1.5** (H Company, Apache-2.0) — web-specialized grounding VLM; **our default** (3B).
- **UI-TARS-1.5-7B** (ByteDance, Apache-2.0) — strong end-to-end GUI agent; evaluated as a single-model benchmark (heavier on 18GB, needs native prompting).
- **Qwen2.5-VL** — the general-purpose base these are fine-tuned from; useful as a control.
- **GUI-Actor**, **UGround**, **OmniParser** — alternative grounding approaches kept in the design space.

## Relationship to koretex

[koretex](https://github.com/koretex-ai) is our network for running models locally on Apple Silicon. It serves text/code models — and now **vision-language models too**, over the same OpenAI-compatible `/v1/chat/completions` endpoint (a VLM streams text like any chat model; it's simply kept out of the throughput-based hardware ranking, since image prefill distorts tokens/sec).

That makes **both halves of this agent first-class koretex workloads**: the **text planner** and the **vision grounder** can each run locally on your own machine *or* ride the koretex network. In practice the grounder benefits from running close to the browser loop for latency, but nothing in the architecture forces it to stay local. Agent and node share the same pinned Ollama engine, so they converge cleanly.

## Proof it works (Phase 0)

We rendered realistic web pages at a fixed resolution and scored whether the model's predicted click lands inside the target element (ScreenSpot-style). On a **Mac M3 Pro / 18GB**:

- **Holo1.5-3B hit 3/4** grounding cases at **~55–59 tok/s**, including correctly disambiguating the middle of three identical buttons.
- **Engine ≥ Ollama 0.30.x is required** — older builds can't run Qwen2.5-VL-class models (no M-RoPE support).
- Latency is **image-prefill bound** (~5s/call) → screenshot downscaling is a first-class lever.

Full method + numbers: [phase0/RESULTS.md](phase0/RESULTS.md). The harness is runnable — see [phase0/](phase0/).

## Roadmap

- **Phase 0 — Feasibility spike.** ✅ Done. Local 3B vision grounding is viable on 18GB.
- **Phase 1 — Shell + chat loop.** Side panel talking to the local model.
- **Phase 2 — Perception + executor.** DOM/SoM extraction, downscaled screenshots, action execution.
- **Phase 3 — Agent loop.** Planner → Grounder → Executor → Validator with bounded retries.
- **Phase 4 — Modular models + hybrid grounding.** Split grounder/planner; add vision fallback; benchmark and lock defaults.
- **Phase 5 — Trajectory logging + guardrails.** Training-ready records, human-in-the-loop confirmation for sensitive actions.
- **Phase 6 (optional) — CDP/native escape hatch** for actions the extension sandbox blocks.

## Repository layout

```
README.md            — this file
DESIGN.md            — full architecture & implementation plan
phase0/              — feasibility-spike harness
  pages/             — realistic test pages (HTML)
  shots/             — rendered screenshots (1280×800)
  ground_truth.json  — target boxes + instructions
  render.sh          — render pages → PNG (headless Chrome)
  run.py             — grounding benchmark (stdlib only)
  RESULTS.md         — Phase-0 findings
```

## Safety

The agent is designed to keep a human in the loop for anything irreversible — purchases, sends, deletes, auth changes — and never executes financial transactions autonomously. Bounded autonomy (max steps/retries), a visible stop control, and per-step visibility are core requirements, not add-ons.

## License

TBD.
