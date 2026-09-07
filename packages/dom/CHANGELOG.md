# @vectojs/dom

## 0.2.0

### Minor Changes

- 85ebee9: New `@vectojs/dom` P1 prototype (RFC2, CTX-0598): `DOMProjection` backend behind the `ProjectionBackend` mount/update/unmount interface — world-matrix to CSS `matrix3d()` sync with mandatory `transform-origin: 0 0`, tag-keyed element pool, dirty-checked per-frame updates, DOM event bridge with `source: 'dom'` attribution plus Selection/Orbit interaction-mode remap, ResizeObserver intrinsic-size readout, and focus-sentinel fallback. Prototype node set: `DOMText` / `DOMButton` / `DOMInput` / `DOMContainer` / `DOMTransform` (explicit `domPolicy: 'dom'` opt-in only; `'auto'` is CTX-0601). Core side (additive): `VectoEventSource` + `VectoJSEvent.source`, `Entity.domPolicy` / `domKind` / `domResident` plain-data fields, `Scene.addProjectionBackend` / `removeProjectionBackend`, render-walk hook + prune pass, `shouldProjectA11y` gate so a `'dom'`-policy node's live element replaces its transparent mirror.
- 3e609d7: Capability negotiation for visual projection policy (RFC4 §§2/3/4, CTX-0601): `Entity.domPolicy: 'canvas' | 'dom' | 'auto'` (the RFC §2 `projection` knob under its in-tree name) now negotiates `'auto'` per node per frame instead of treating it as canvas. Core ships the Capability Matrix as data (`ProjectionPolicy.ts`: rows as opinions-to-measure with per-row `autoDefault`), the pure `resolveProjection` rule set (explicit beats automatic, fallbacks reported with `ProjectionFallbackReason`, no-DOM short-circuits to canvas), sticky `hysteresisVote`, and the scene-side `Scene.resolveProjectionFor` (per-frame memo, gesture/focus hard bars, bulk auto-DOM budget) with the per-scene queryable surface (`scene.projectionCapabilities`, `getProjectionResolution(s)`) and capability registry (`registerProjectionCapability`). `ProjectionBackend` gains the optional `hasActiveGesture` consult; `@vectojs/dom` implements it via new `onGestureStart`/`onGestureEnd` bridge callbacks (user callbacks still compose). `@vectojs/markdown` gains the DOM-free dogfood switcher (`applyProjectionMode`, `classifyProjectionBlocks`, `MarkdownProjectionMode`) consumed by `benchmarks/projection-policy`. Canvas policy never touches backends (byte-identical fast path). Tunables: `PROJECTION_AUTO_HYSTERESIS_FRAMES` (3), `PROJECTION_AUTO_DOM_BUDGET` (500), both overridable per scene.

### Patch Changes

- Updated dependencies [85ebee9]
- Updated dependencies [9a6007f]
- Updated dependencies [9d2c35e]
- Updated dependencies [3e609d7]
- Updated dependencies [dc2e93d]
  - @vectojs/core@1.40.0
