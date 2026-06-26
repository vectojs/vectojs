# @vecto-ui/core

## 0.3.0

### Minor Changes

- 42819e7: Add opt-in draw-call batching for point-cloud / particle entities.

  - `IRenderer.fillCircle(cx, cy, radius, color, alpha?)` + `flush()`: an
    order-preserving batch that coalesces consecutive same-color circles into a
    single `beginPath` + N `arc` + one `fill()`. Capped at `MAX_BATCH` (64) so a
    single Canvas 2D `fill()` never grows large enough to hit its superlinear
    multi-subpath cost.
  - `Entity.getBatchCircle()` (default `null`): a leaf entity that draws as a
    uniform-scaled filled circle returns `{ radius, color }` to opt in.
  - `Scene` draws such leaves through the batch, skipping their per-entity
    `save`/`translate`/`scale`/`rotate`/`restore` and `render()`, flushing per
    sibling group so painter's order is preserved.

  Measured: ~34% faster at 10k circles (60→91 fps), neutral at 1k and at 100k
  (no regression). Default entities are unaffected.

- 3eb0910: Add an opt-in WebGL2 point-cloud layer — the GPU lever for 100k+ point clouds
  that Canvas2D can't reach.

  - `new Scene(canvas, { pointBackend: 'webgl' })` renders every `getBatchCircle()`
    entity through a stacked WebGL2 `gl.POINTS` layer in a single draw call. Defaults
    to `'canvas'`; auto-falls back to the Canvas2D batch when WebGL2 is unavailable.
  - New `createWebGLPointRenderer(canvas)` / `PointRenderer` and `parseColorToRGBA`
    exports.
  - Benchmarked (software GL): 100k circles 7→25 fps (3.5×); 500k–1M point clouds
    become feasible. Hardware GPU is faster still.

  Tradeoff: GL points form one composited layer above the 2D content (no per-entity
  painter interleaving with 2D draws). Default scenes are unaffected.

## 0.2.0

### Minor Changes

- cd59328: Add real font metrics for non-atlas text via a canvas-backed glyph measurer.

  - New `createCanvasMeasurer(fontFamily?, baseSize?)` returns a `GlyphMeasurer`
    that measures each grapheme once with canvas `measureText` (cached, scaled
    linearly by font size), or `null` in DOM-free environments.
  - `LayoutEngine` accepts an optional measurer; glyph width now resolves in
    priority order **atlas → measurer → `0.5em` fallback**, fixing line-breaking
    for text without a pre-baked vector atlas.
  - `TextEntity` wires a shared `sans-serif` measurer by default, so it lays out
    with real metrics out of the box.

  Validated against DOM ground truth: empty-atlas line-count error dropped from
  −50%…+27% to **0%** (matching the real-atlas path) across Latin and CJK; the
  remaining Arabic gap is bidi/shaping, not measurement.

- cd59328: Add rendering-performance controls to `Scene` and `Entity`.

  - Viewport culling: `Entity.getBounds()` (default `null` = never culled) lets the
    render loop skip off-screen entities. Lifts large/scrolled scenes (e.g. 10k
    mostly off-screen entities) back to 60fps.
  - On-demand redraw: `Scene.renderMode = 'onDemand'` + `markDirty()` make static /
    event-driven UIs idle at ~0 cost regardless of entity count.
  - Accessibility early-out: `Scene.syncA11y` is skipped when no interactive
    entities are present.
  - The render loop propagates the world transform as scalar params (zero per-node
    allocation).

- 6463b61: Add `SplineEntity` — first-class rendering of vectomancy's native `Spline` JSON
  (piecewise-cubic curves) directly to canvas:

  - Converts polynomial segments to cubic Béziers (`polySegmentToBezier`), draws all
    equations, and supports per-equation solid `[r,g,b]` colors and linear gradients.
  - Bounds come from the document's `bounding_box` (or are computed), so the entity
    participates in viewport culling via `getBounds()`.
  - Bakes to an `OffscreenCanvas` by default for 60fps blitting, with a per-frame
    curve-drawing fallback when `OffscreenCanvas` is unavailable.
  - AABB hit-testing with a `hitTestCurve()` seam for future curve-accurate picking.
  - `loadSpline(url)` helper to fetch + parse a spline document.

## 0.1.1

### Patch Changes

- Fix two layout/transform correctness bugs:

  - `LayoutEngine.layoutText` now reports `totalWidth` as the actual longest line
    width instead of `maxWidth`, so `TextEntity.width` (and its hit-area / a11y
    shadow box) reflects the real text bounds.
  - `Entity.getGlobalPosition` now applies non-uniform scale correctly under
    rotation, matching the Canvas `translate → scale → rotate` order used by the
    renderer. Behaviour only changes when `scaleX !== scaleY` and `rotation !== 0`.

## 0.1.0

### Minor Changes

- 6917a2c: Prepare packages/core for v0.1.0 package release: configured tsup builder, added ESM/CJS exports, completed zero-GC LayoutResultBuffer refactoring, unified pointer event mapping, implemented Scene.destroy(), and added Intl.Segmenter word caching.
