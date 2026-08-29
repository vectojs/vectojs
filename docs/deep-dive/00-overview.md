---
title: "00 — Overview: The Twelve Bosses of VectoJS"
description: "A navigation guide to VectoJS's twelve deep-dive bosses — the game map, architecture invariants, package dependencies, and reading paths for every newcomer."
order: 20
---

# 00 — Overview: The Twelve Bosses of VectoJS

## The game

VectoJS re-implements browser responsibilities on a single `<canvas>`: layout, hit-testing, event dispatch, text shaping, clipping, scrolling, accessibility, and rendering — all from explicit arithmetic over a retained entity tree. Think of the framework as a game with **twelve bosses**, each guarding one subsystem that the DOM used to give you for free and that VectoJS must now get exactly right. You don't fight them in order, but you do need to know the map before you pick a fight.

This document is that map.

- **What you'll learn here**: the runtime architecture in one picture, the package dependency skeleton, which invariant each boss threatens, how to choose a reading order, and where these deep-dives sit relative to the existing `content/learn/*` and `content/reference/*` docs.
- **What you won't**: the mechanics of any single boss. Each deep-dive owns its boss. This overview links you there and gives you just enough to arrive oriented.

## Architecture at a glance

```text
            Application state
                   │
                   ▼
         ┌─────────────────────┐
         │  Virtual Math Tree  │   Entity tree: transforms, bounds, events,
         │  (Scene + Entities) │   dirty/invalidation, worldMatrix. packages/core/tree/Scene.ts:1107
         └─────────┬───────────┘
                   │  dirty, transforms, culling
         ┌─────────▼───────────┐
         │  Layout  / HitTest  │   LayoutEngine (@vectojs/layout), HitTester (@vectojs/core),
         │  / Animation        │   Tween/Spring drivers (@vectojs/animation), physics (@vectojs/math)
         └─────────┬───────────┘
                   │  draw calls / glyph quads / animation frames
         ┌─────────▼───────────┐         ┌──────────────────────────┐
         │   Canvas + GPU      │         │   Thin DOM projection    │
         │  Canvas2D (default) │         │  a11y shadow elements:   │
         │  WebGL  / WebGPU    │◄───────►│  getA11yAttributes(),    │
         │  SVG / Three.js     │  sync   │  a11yProjection modes,   │
         └─────────────────────┘         │  syncA11y walk           │
                                         └──────────────────────────┘
                   │                              │
                   ▼                              ▼
              Visible pixels              Screen readers, IME, Playwright,
                                         copy/find, AT automation
```text

Source-of-pixels is always the canvas. The DOM carries **semantics and native input** only; it does not render the visible scene. The two worlds are kept in sync by a depth-first walk (`Scene.syncA11y` / `ContentProjectionManager`, see `packages/core/src/tree/scene/A11yProjectionManager.ts:30`) that runs after layout and before presenting a frame.

Reference renderings of nearby pictures already live in the docs: [Runtime Architecture](/learn/runtime-architecture/) and [Engine Concepts](/learn/engine-concepts/) (central VMT hub diagram). This text diagram is intentionally code-referenceable and printable.

## Package dependency skeleton

Leaf engines first, composition upward. The graph is acyclic; arrows mean "imports from at build time":

```text
  @vectojs/text ─┐
                 ├─► @vectojs/layout ─┐
  @vectojs/math ─┤                    │
                 └─► @vectojs/animation├─► @vectojs/core ─┬─► @vectojs/ui ─┬─► @vectojs/markdown
                                                          │                  └─► @vectojs/markdown-app
                                                          ├─► @vectojs/styles
                                                          ├─► @vectojs/table / @vectojs/node-editor
                                                          │
                                   @vectojs/tex ──────────┤  (consumed by markdown; public API)
                                                          │
           @vectojs/graph-layout ─► @vectojs/graph3d ─────┤  (@vectojs/knowledge-graph above graph3d)
           @vectojs/three / @vectojs/devtools /            │
           @vectojs/video-exporter / @vectojs/desktop      ┘  (host apps atop core+ui)

  crates/vectojs-core-rs (Rust → wasm32)  — invisible accelerator behind @vectojs/core
```text

Verified against `packages/*/package.json` dependencies (`text`/`math`/`graph-layout`/`tex` have zero `@vectojs/*` deps; `layout→text`, `animation→math`, `core→{layout,text,math,animation}`, `markdown→{ui,tex,core}`). Build respects this order (`package.json:14`). Tests alias sibling packages to `src/` via `vitest.config.ts`, so the ordering governs `.d.ts` emit, not test execution.

Two consumer traps to watch when tracing deps: spurious `references/` paths are hardcoded in `packages/tex/scripts/vendor-katex.ts` (`--source`) and `scripts/compare-pretext.ts` (`VECTO_PRETEXT_PATH`) — moving that tree breaks them silently (per `AGENTS.md`).

## The twelve bosses + this overview

13 documents total: this overview (00) plus one per boss. Difficulty is effort-to-get-wrong, not code volume. "First read" is the fastest path to _useful_ VectoJS work; "deep prerequisite" is the one other boss you should have read before tackling this one.

| #   | Boss (deep-dive)                                                     | Package(s)                                                                    | Difficulty | Who should read this                       | Deep prereq | First-read for…                          |
| --- | -------------------------------------------------------------------- | ----------------------------------------------------------------------------- | ---------- | ------------------------------------------ | ----------- | ---------------------------------------- |
| 00  | **Overview & navigation** (this doc)                                 | — (meta)                                                                      | ☆          | Everyone, first stop                       | —           | orientation                              |
| 01  | **Canvas-native selection** — dual-world sync                        | `core` (`ContentGridProjector`, `ContentProjectionManager`), `text`, `layout` | ★★★★       | Text/selection/IME, copy/find/translation  | 02          | selectable text, terminals, code editors |
| 02  | **Text + Layout** — Unicode/BiDi/shaping/排版                        | `text`, `layout`, `core/text`                                                 | ★★★★       | Layout engine, i18n, typography            | —           | any text beyond ASCII                    |
| 03  | **Semantic projection + virtualization** — materialization lifecycle | `core/a11y`, `ui`, `markdown`, `table`                                        | ★★★        | a11y, virtualization, dense docs           | 06          | large docs, lists, dashboards            |
| 04  | **Streaming Markdown** — incremental reconcile                       | `markdown`, `ui`, `layout`                                                    | ★★★        | Streaming/LLM UI                           | 02          | chat/streaming readers                   |
| 05  | **Zero-DOM TeX** — layout + SVG emit                                 | `tex`                                                                         | ★★★        | Math rendering                             | 02          | formulas in Markdown                     |
| 06  | **VMT runtime** — dirty/invalidation/lifecycle/events                | `core/tree`, `core/layout`, `core`                                            | ★★★★       | Scene/Entity lifecycle, hit dispatch, perf | —           | custom entities, perf debugging          |
| 07  | **Renderer** — coordinate/clip/DPR consistency                       | `core/renderer`, `core/performance`                                           | ★★★        | Multi-backend, HiDPI, culling              | 06          | canvas/WebGL/WebGPU work                 |
| 08  | **WASM triple — G1/G2/G3** — bit-identical acceleration              | `crates/vectojs-core-rs`, `math`, `animation`, `graph-layout`, `core/wasm`    | ★★★        | Perf, Rust↔JS parity                       | 06, 07      | frame budgets at scale                   |
| 09  | **Three.js / XR bridge** — two coordinate worlds                     | `three`, `graph3d`                                                            | ★★         | 3D panels, XR                              | 06, 07      | VectoJS inside Three.js                  |
| 10  | **Deterministic video export** — fixed-step clock                    | `video-exporter`                                                              | ★★         | Offline capture, replay                    | 06          | screen recording, simulation export      |
| 11  | **Graph layout** — force-directed + WASM                             | `graph-layout`, `graph3d`, `knowledge-graph`                                  | ★★         | Graph viz, layout tuning                   | 06, 08      | network/knowledge graphs                 |
| 12  | **DevTools** — runtime introspection & audit                         | `devtools`, `core` (`frameStats`, `syncA11y`)                                 | ★          | Debugging, CI audit                        | 06          | "why is this entity here"                |

Ordering notes:

- 02 and 06 are the two best "second reads" after 00 if you must pick two — most other bosses assume one of them.
- 03 leans on 06's dirty/lifecycle machinery; 04 leans on 02's shaping/layout; 07 and 08 both lean on 06 and therefore cluster naturally after it.
- 08's difficulty is not Rust syntax but the **bit-identical fallback contract** and its build trap (`RUSTFLAGS` in `crates/vectojs-core-rs/build.sh`).
- The team tracker already sequences `CTX-0566→…→CTX-0578→CTX-0579`; the table above is the reading order, which is allowed to differ from build/release order.

## Three invariants that govern every boss

Each boss can break one of these. If you remember nothing else, remember the invariants.

### 1. VMT lifecycle invariant

> An entity's **dirty flag, worldMatrix, and child list** agree after every `Scene` step.

Symptom when broken: stale bounds after `remove(child)` without driver unregistration (`Entity:1582`), phantom hit targets after a partial `markDirty`, transforms that diverge between JS and the WASM SoA store (`crates/vectojs-core-rs/src/*.rs`, G1). Guard: `Scene.ts:532` `renderMode` / `DirtyTracker.ts:33` contract, `DriverTicker.ts:40` walk, `Entity.ts:782` subclass contract. 90% of "mystery render glitches" trace here.

### 2. Dual-world parity invariant

> Every **visible interactive** entity has a **synchronized a11y counterpart** whose geometry, role/name/state, and focus/pointer routing match the canvas truth.

Symptom when broken: Playwright `getByRole` finds nothing, screen readers announce stale text, clicks hit the wrong entity, IME lands on the wrong box. Guard: `Entity.ts:295` `A11yAttributes`, `Entity.ts:968` `a11yProjection` modes (`eager`/`onDemand`/`never`), `Entity.ts:1937` `getA11yAttributes()` default, the shared `syncA11y` walk (`A11yProjectionManager.ts:30`, `ContentProjectionManager.ts:26`), and `A11yProjectionManager.ts:227` stale-memo invalidation. `onDemand` materialization and viewport virtualization are the hard parts (boss 03) — that's also where most real-world VectoJS stalls live.

### 3. Text metric invariant

> **Measure once, layout many** — and measure with the **real** font, on the **right** context, at the **right** DPR.

Symptom when broken: text drifts from its hit box, selection bands offset by a line, CJK sub-pixel gaps paint as white lines, web-font fallback silently changes advances, DPR zoom blurs one subsystem but not the other. Guard: `packages/text/src/fontMetrics.ts:82` `registerFontMetrics`, `packages/text/src/Typography.ts:111` `ctx.measureText('Mg')` with DOM-free fallback to 0.5em, `packages/text/src/measureContext.ts:12` measure-context calibration, `packages/layout/src/LayoutEngine.ts:808` `LayoutEngine` cold/hot split and paragraph memoization. Every boss that touches text (01, 02, 04, 05) re-enters this invariant from a different angle.

Keep these three as a checklist during review: before approving any change, ask "which invariant could this break, and where would it surface first?"

## How these deep-dives relate to existing docs

| Existing docs                                                                                                                        | Deep-dives (this series)  | Relationship                                                                                                                                                                                                                                                                                               |
| ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `content/learn/*` (introduction, runtime-architecture, engine-concepts, text-typography, core-scene, accessibility, streaming, etc.) | 00–12                     | **Learn teaches how to _use_ VectoJS**; deep-dives teach **how VectoJS _works_ inside** that usage. Reading a learn chapter first makes the corresponding boss cheaper. Suggested pairs: `text-typography` → boss 02; `core-scene` + `events` → boss 06; `accessibility` → boss 03; `streaming` → boss 04. |
| `content/reference/*` (core-a11y, core-entities, core-layout, core-text, ui-markdown, three-adapter, graph-layout, etc.)             | 00–12                     | **Reference is API truth** (props, types, subpaths). Deep-dives cite reference pages but do not restate them. When in doubt, the reference signature wins.                                                                                                                                                 |
| `forge/findings/*` + `forge/baselines/*`                                                                                             | each deep-dive's appendix | Findings are the **field notes**; baselines are the **measured evidence**. Deep-dives synthesize findings into a single narrative per boss and link back to the `file:line` entries that earned the claim.                                                                                                 |
| `vectojs/AGENTS.md` + `vectojs/README.md`                                                                                            | 00 (this doc)             | Package map, build order, and render/interaction model are **copied from AGENTS.md and README.md verbatim in meaning** and verified against `package.json` — not invented.                                                                                                                                 |

Rule: **authoritative side first**. If a fact appears both in a learn/reference page and in a deep-dive, the learn/reference page is the correction target. Never `cp -r` between `vectojs-docs/content` and `vectojs-website/src/content` (per `AGENTS.md` — formatting drift + 408 i18n files).

## Reading paths — pick yours

**"I just joined"** — 00 → 02 (text/layout) → 06 (VMT lifecycle) → 07 (renderer) → the boss nearest your first task. Two afternoons, enough to land a real PR.

**"I own a feature"** — 00 → your boss → its deep prereq row → the corresponding `content/learn/*` chapter → `forge/findings/<area>.md` for that boss. Skim the invariant section again before review.

**"I own perf"** — 00 → 06 → 07 → 08 (WASM G1/G2/G3) → 11 (graph) — then `benchmarks/run-browsers.sh` and `forge/baselines/*.json`. Only `run-browsers.sh` numbers are quotable.

**"I own a11y / dense docs / tables"** — 00 → 06 → 03 → (01 if selection/copy matters for your surface).

**"I own 3D / XR / graph viz"** — 00 → 06 → 09 → 11 → (08 if layout compute is your budget).

Each deep-dive frontmatter declares its `order`, `package` set, and `prereq` list so Zola and the sidebar stay ordered even if a reader jumps in mid-series.

## Conventions & verification standard

- All code refs are `file:line` verified via `ctxctl outline` → `grep -rn` → `read` before writing (never from memory). Ambiguous refs include the function/class name.
- Zola frontmatter is required on every doc (`title`, `description`, `order`). Headings use H2/H3 + fenced code blocks (per global AGENTS.md).
- Token/lint gate: run `just fmt` / `just check` equivalents on docs changes where applicable before PR; on `vectojs-docs` side, `scripts/sync-content.py` drift check before push.
- Keep each deep-dive under ~600 lines; this overview under ~400. Dense over verbose; link, don't duplicate.

## Next step

Pick your path above. A conventional next read is **Boss 01 — Canvas-native selection** if you touch text, or **Boss 06 — VMT runtime** if you touch lifecycle/events — both are short on-ramps to the harder pair (02, 08).

---

_Series: 00 Overview → 01 Selection → 02 Text+Layout → 03 Projection+Virtualization → 04 Streaming Markdown → 05 TeX → 06 VMT Runtime → 07 Renderer → 08 WASM G1/G2/G3 → 09 Three/XR → 10 Video Export → 11 Graph Layout → 12 DevTools → 99 Synthesis._
