# @vectojs/devtools

## 0.7.0

### Minor Changes

- 2589602: Add dirty-reason attribution, so you can find out what keeps an `onDemand` scene awake.

  `renderMode: 'onDemand'` exists so an idle scene costs nothing, but it silently
  degrades to always-on the moment something marks the scene dirty every frame — and
  `dirty === true` says only _that_ it happened, never _what_ did it. Diagnosing that
  meant bisecting `markDirty()` call sites by hand.

  `markDirty()` now takes an optional source:

  ```ts
  scene.markDirty({
    entity: this.id,
    reason: "text-changed",
    property: "spans",
  });
  ```

  Attribution is off by default and recording costs nothing until
  `scene.setDirtyTracking(true)`, because `markDirty` is called from dozens of sites,
  several per frame, so the common path stays a single field write. Read the
  aggregated counts from `scene.dirtyReasons`.

  The engine's own call sites already carry attribution, so an animation or a
  child add/remove is identifiable without instrumenting anything.

  `@vectojs/devtools` adds `diagnoseDirty(scene)` (also on the `headless` entry),
  which turns the counts into a verdict:

  ```
  Continuous redraw detected: answer — streaming-text marked the scene dirty
  120x over 120 frames (1.00/frame). onDemand cannot idle while this continues.
  ```

  It distinguishes a cause firing every frame from one that merely fired often, and
  says plainly when `renderMode` is `'always'` (which makes the whole question moot)
  or when tracking was never enabled — reporting "no causes" in that case would read
  as a false all-clear.

## 0.6.0

### Minor Changes

- 394b958: Add a selection-overlap audit: `auditSceneSelection(scene, opts)` / `auditEntitySelection(scene, entity, opts)` report where a selectable text entity's transparent DOM content projection (what the browser lets users drag-select and copy) drifts from the glyphs the canvas actually drew. It compares live `Range.getClientRects()` against the entity's own `ContentProjection` line geometry, mapped into local logical px so the check is DPR/zoom-independent — catching the justify (widened gaps), RTL/bidi (visual reorder), and fractional-scale rounding failure modes. Empty result = every selection box tracks its glyphs, so it doubles as a QA gate when driven on a real browser (see `scripts/selection-harness`).

### Patch Changes

- b2530ae: Broad-phase the layout audit's sibling-overlap check. `auditTree` compared every
  sized sibling against every other one — O(k²) intersection tests _and_ O(k²)
  `worldBox()` calls, since the inner loop recomputed the other box each time — so
  auditing a long list or a wide table was quadratic in exactly the thing you most
  want to audit. Boxes are now computed once and candidates filtered through a
  `SpatialHashGrid` (the same broad phase the engine already uses for hit testing;
  re-exported by `@vectojs/core`, so no new dependency).

  Findings are unchanged — same pairs, same tolerance, same `ignoreOverlap`
  handling — verified against an exhaustive all-pairs reference over dense grids,
  wildly-varying box sizes, and sparse long lists.

  Measured on one parent with N non-overlapping rows (median of 7,
  `forge/baselines/devtools-audit-overlap-broadphase.json`): 200 rows 5.35 → 0.82ms
  (6.5×), 1000 rows 75.8 → 1.7ms (44×), 4000 rows **1280.7 → 7.4ms (173×)**. This is
  a dev-only path, so it buys tooling responsiveness rather than app frame time.

## 0.5.0

### Minor Changes

- 90a9f00: Modernize the inspector panel and add five features. Visual: the dock now has rounded inner corners, a soft drop shadow, a translucent blurred-glass background, and `Card`-grouped sections; the three actions became compact ghost text-glyph icon buttons (`⌖`/`⟳`/`⚠`) with tooltips. Features: (1) the tree, entity readout, audit findings, event trace, and settings are split across `Tabs`; (2) a filter `Input` narrows the tree by type/id substring (view-only — the index still resolves every entity) with header count badges for total/interactive/findings; (3) a live perf HUD strip reads `Scene.frameStats` (fps, ms/frame, entity count, render mode, rendered/skipped frames); (4) the Inspect tab gains inline `x`/`y`/`opacity` editors and Copy-path / Copy-state-JSON actions; (5) a Settings tab toggles the selection highlight and switches the refresh interval and dock side (left/right). New `DevtoolsOptions`: `dockSide`, `showPerf`, `defaultTab`; default `width` is now `360`. The panel now reflows on `window.resize` (the panel scene uses `disableWindowResize`, so it previously kept its construction-time height and pushed the bottom perf strip below the fold on shorter viewports/zoom); inline editors and the perf strip use larger, higher-contrast text; and tab/label/button widths were sized to avoid truncation. The `pointer-events: none` dock contract, `attachDevtools`, and all existing public methods are unchanged.

## 0.4.3

### Patch Changes

- 3cf1c58: Fixed `attachDevtools`' docked panel intercepting pointer input over the host page's right edge. The dock is a fixed `320px`-wide, full-viewport-height element pinned to the right (`position: fixed; right: 0`), and both the dock container and its canvas now set `pointer-events: none` — matching how the main `Scene`'s own `a11yRoot` works (the root opts out, individual interactive shadow elements opt back in via `auto`). Previously the dock container defaulted to `pointer-events: auto` (the unset browser default), so any click landing in that 320px band silently missed whatever host content was underneath it, even when the dock had no interactive chrome at that exact pixel — this affected every app's own right-edge controls (tab close buttons, toolbar buttons, etc.) whenever `?debug`/`attachDevtools` was active, and had already corrupted a forge audit's own headless interaction test before being caught. The panel's own buttons and VMT tree remain independently clickable through their a11y shadow elements, which set their own `pointer-events: auto`.

## 0.4.2

### Patch Changes

- d013893: Finalize event-trace default-prevention state after projected VMT keyboard routing, including in Chromium, and cover the browser timing contract with an end-to-end test.

## 0.4.1

### Patch Changes

- e282f2f: Route browser pointer cancellation through projected entities and DOM portals, release projected pointer capture safely, and retain cancellation in DevTools event traces.

## 0.4.0

### Minor Changes

- fc96dfa: Make browser-native text selection a reusable VectoJS contract. Core now keeps dynamically
  materialized content projections in VMT order, removes them with their subtree, hides projections
  outside clipping ancestors, and exposes `Scene.getContentElement()` for tooling. UI adds
  configurable selection to Text, RichText, Markdown, CodeBlock, and Table cells; projects fenced
  code; preserves RichText wrap points; and gives Table an explicit, render-pure layout pass with
  wrapped, single-owner cell projections. UI's Core peer range is also aligned with its stable API
  contract (`>=1.0.0 <2.0.0`). DevTools event traces now report `source: "content"` for events
  originating on projected selectable text.

## 0.3.1

### Patch Changes

- 8bbb5a2: Add the `@vectojs/devtools/headless` entry for audits, event traces, snapshots, inspection, and picking without bundling the visual panel or `@vectojs/ui`.

## 0.3.0

### Minor Changes

- Add an opt-in, bounded event-routing trace for pointer, wheel, and keyboard
  events. The in-page panel can render recent trace entries, while
  `createEventTrace` provides the same JSON-safe records to tests and agents.

## 0.2.0

### Minor Changes

- 72d8b3d: Headless audit + capture layer for state-space debugging:

  - `auditScene(scene, opts?)` / `auditTree(root, sceneBounds, opts?)` — structured layout findings: `text-overflow` (text escaping its container), `clip-overflow` (content cut off by a clipping ancestor, scroll-axis exempt for ScrollView-likes), sibling `overlap`, and `viewport-overflow` (drawn off-canvas). Deterministically sorted, JSON-safe, with `tolerance`/`ignore`/`ignoreOverlap`/`includeOverlay` options.
  - `inspectEntity(entity)` — structured `EntityInfo` (world bounds/transform, flags, text preview, a11y projection), the machine-readable sibling of `describeEntity`; plus `entityPath(entity)` and `textPreviewOf(entity)`.
  - `captureSnapshot(scene)` / `diffSnapshots(a, b)` — deterministic JSON scene-state tree and a structural-path-keyed diff for golden-state assertions.
  - Panel: new **Audit** button lists findings in place of the tree; `panel.audit()` and `panel.selectFinding(i)` drive the same flow programmatically.

## 0.1.1

### Patch Changes

- Tighten the `@vectojs/core`/`@vectojs/ui` peer dependency ranges to `>=1.0.0 <2.0.0` now that both have reached 1.0.0. The previous unbounded `>=0.1.0`/`>=0.2.7` ranges would have silently accepted a future breaking `2.0.0` of either package with no peer-dependency warning, defeating the point of the semver commitment.

## 0.1.0

### Minor Changes

- d00abdd: New package @vectojs/devtools: the in-page Virtual Math Tree inspector — live tree view with type/geometry/animation badges, one-shot entity picking, world-transform readout, keyboard nudge editing, and a host-overlay selection highlight; the panel itself is rendered with VectoJS. Core gains read-only Scene.rootEntity/overlayRootEntity accessors for tooling.
