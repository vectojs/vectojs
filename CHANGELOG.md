# Changelog

VectoJS is a monorepo. **Per-package, machine-generated changelogs are the source of truth:**

- [`@vectojs/core`](./packages/core/CHANGELOG.md)
- [`@vectojs/ui`](./packages/ui/CHANGELOG.md)
- [`@vectojs/three`](./packages/three/CHANGELOG.md) — versioned independently of the
  core/ui changeset flow; see that file directly.

This file keeps a curated, high-level history. Versioning follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html) via
[Changesets](https://github.com/changesets/changesets) for `core`/`ui`; `three` is bumped
and tagged by hand (`@vectojs/three@<version>`), which triggers the npm-publish workflow.

## Highlights

### core 0.1.0 · ui 0.1.0 · three 0.1.0 (2026-07-01)

Renamed the npm scope from `@vecto-ui/*` to `@vectojs/*` (the GitHub org uses "vectojs";
`vecto-ui` wasn't available), and reset all three packages to `0.1.0` as the new scope's
first release. `VectoUIEvent` was also renamed to `VectoJSEvent` for naming consistency.
This is a clean version reset, not a feature release — see **Pre-rebrand history** below
for everything that shipped under the old `@vecto-ui` name.

### ui 0.1.1 (2026-07-02)

Ten new native UI components, plus a change-event consistency pass.

- **New components (`@vectojs/ui`)** — `Overlay`, `VirtualList`, `TreeView`, `ResizablePanel`,
  `Tooltip`, `Popover`, `ContextMenu`, `RadioGroup`, `Tabs`, `ProgressBar`.
- **Change-event alignment** — `Toggle`, `Checkbox`, `Input`, `Dropdown`, and `Slider` now
  fire their change callbacks through the same consistent shape.

### three 0.1.1 (2026-07-02)

- **Fix: no longer dispatch to detached a11y elements (`@vectojs/three`)** — `ThreeAdapter`'s
  canvas is always offscreen (rendered into a texture, never inserted into the page), so its
  a11y shadow root is created but never attached to `document`. `getA11yElement()` could
  still return a real-but-permanently-disconnected element, and the adapter dispatched to it
  anyway — silently dropping `onClick`/`onChange` on the floor with no error (native DOM APIs
  like `setPointerCapture` could also throw). `dispatchEventToTarget` now checks
  `a11yEl.isConnected` and falls back to the same direct entity-dispatch path already used
  when no a11y element exists at all. See [`/reference/three.md`](https://vectojs.dev/reference/three/)
  on the docs site for the full explanation.

---

## Pre-rebrand history (`@vecto-ui/*`)

Everything below shipped under the old `@vecto-ui` npm scope, before the 2026-07-01 rename
and version reset. Kept for historical reference — none of these version numbers exist under
the current `@vectojs/*` scope.

### core 0.9.0 · ui 0.4.0 (2026-06-28)

High-performance WebGPU particle system and Native BiDi bidirectional text with complex shaping.

- **WebGPU Particle Layer & Simulation (`core`)** — High-performance WGSL Compute Shader integration for 1,000,000+ particles, zero-copy render pipelines, and zero-alignment empty holes. Elegant GPU device lost recovery mechanism with exponential backoff retries, combined with a seamless CPU simulation fallback.
- **Native BiDi & Arabic/Hebrew/Persian shaping (`core`)** — Lightweight block range character mapping (<5KB), UAX #9 Bidirectional algorithm level resolution, contextual shaping engine, and contiguous visual line reordering under text exclusions and floated layouts.
- **UI input components Bidi support (`ui`)** — Bidi-aware logical caret positioning and visual coordinates interpolation, together with disjoint visual selection highlights in Input and TextArea.

### core 0.7.1 · three 0.2.0 (unreleased)

WebGL/Three.js 3D space UI adapter integration and custom viewport control.

- **3D Space UI Adapter (`three`)** — Bridges VectoJS's 2D layout/component system into Three.js 3D/WebXR. Features dynamic `CanvasTexture` update intercepting, universal 3D-to-2D raycast event translation, multi-pointer WebXR state tracking, event routing to transparent DOM overlays, hover transition boundaries, and clean resource disposal.
- **Offscreen Canvas & Custom Viewports** — Added `disableWindowResize` to `SceneOptions` and exposed a manual `Scene.resize(width, height)` API, allowing Vecto core to run on custom-sized canvas texture layers without window listener interference.

### core 0.6.0 · ui 0.3.0 (unreleased)

Rich typography, GPU text, and a leaner repo.

- **Inline rich text** — bold/italic/colored/differently-sized runs flowing and wrapping on a
  shared baseline (`RichText`, `LayoutEngine.prepareRich`).
- **Inline links with a11y** — an `href` run is underlined on canvas and projects a real,
  operable `<a href>` shadow node (agent- and screen-reader-drivable).
- **Text flow around exclusion rects** ("文字绕流") — `computeLineSegments` + per-line
  segment flow, like CSS floats.
- **Streaming / typewriter** — `prepareRich` paragraph memoization makes a growing styled
  document re-lay out in O(changed paragraph); `RichText.appendSpans` / `Text.append`.
- **MSDF GPU text + off-thread layout** — `MSDFFont`, `MSDFTextEntity` (WebGL median/`fwidth`
  with a Canvas 2D fallback), `LayoutWorkerManager` (Web Worker reflow).
- **Streaming Markdown** + components — `Markdown` (`appendMarkdown`), `Table`, `Dropdown`,
  `Slider`, `Modal`, `Flow`, multi-line `TextArea`.
- **Engine-only repo** — demos and docs moved to
  [vectojs-website](https://github.com/vectojs/vectojs-website); the core repo stays lean.

### 0.1.0 — 2026-06-25

Initial public release of the Canvas 2D ECS engine: rendering runtime (10k+ entities),
`LayoutEngine` (`Intl.Segmenter` reflow), spring physics (with off-thread `SharedArrayBuffer`
fallback), `SpatialHashGrid`, zero-GC `LayoutResultBuffer`, and scene/lifecycle management.
