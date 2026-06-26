# @vecto-ui/core

## 0.5.1

### Patch Changes

- 1de96df: Add a cold/hot layout split to `LayoutEngine` to kill per-frame layout thrashing.

  - **Cold pass** `prepare(text, atlas, fontSize): PreparedText` runs `Intl.Segmenter`
    plus glyph measurement once and returns a constraint-independent, reusable result.
  - **Hot pass** `layoutPrepared(prepared, mask?)` / `layoutPreparedIntoBuffer(...)`
    does only wrap/positioning arithmetic — no re-segmentation, no re-measurement —
    so reflow on resize/reposition is cheap. `layoutText`/`layoutTextIntoBuffer` now
    delegate to these (behavior unchanged).
  - `TextEntity` caches its `PreparedText`: new `setText()` re-prepares (content
    changed) while new `setMaxWidth()` reflows via the hot path only.

  Micro-benchmark (472-char Latin+CJK paragraph, warm caches): reflow is **~3.5×**
  faster on the hot path (0.021 → 0.006 ms/reflow). Exports `PreparedText`,
  `PreparedParagraph`, `PreparedWord`, `PreparedGlyph`.

- 0362f14: IME / text-selection moat for the canvas `Input` (canvas-mirror approach).

  The real, transparent `<input>` shadow node already handles all native input
  (IME composition, selection, clipboard, undo); the canvas now mirrors it visually.

  - **core**: `IRenderer.clip(x, y, w, h)` (rect clip, implemented in `CanvasRenderer`).
    `Scene.syncA11y` forwards IME composition (`{ start, length } | null`), selection
    (`selectionStart`/`selectionEnd`), and new `focus`/`blur` events from text `<input>`
    shadow nodes; the `change` payload is extended accordingly.
  - **ui**: `Input` renders a blinking caret (when focused), a selection highlight, the
    IME composing segment (underlined), and scrolls horizontally to keep the caret in
    view for overflowing text. A human can now type CJK into a pure-canvas field; agents
    still drive it by role.

## 0.5.0

### Minor Changes

- 9abb2b5: Extend the accessibility/automation shadow layer for media and form controls.

  - `A11yAttributes` gains `src`/`alt` (for `tag: 'img'`), `inputType`/`placeholder`/
    `value`/`checked` (for `tag: 'input'`), and `'img'`/`'input'` tags.
  - `Scene.syncA11y` now refreshes dynamic attributes (`aria-label`, `value`,
    `checked`/`aria-checked`) every frame, builds `<img>`/`<input>` nodes, and
    forwards a new `change` event from form-control shadow nodes back to the entity
    (without clobbering a field the user is actively typing in).
  - `SceneOptions.debugA11y` (default `false`): shadow nodes are now transparent
    (`opacity:0`) by default — still operable by Playwright/assistive tech, but the
    canvas is the only thing rendered. Set `true` for the old blue dashed-outline
    debugging view.

## 0.4.0

### Minor Changes

- a888e97: Add GPU rectangle batching to the WebGL point layer.

  - `Entity.getBatchRect()` (default `null`): a leaf entity that draws as a single
    solid rectangle returns `{ width, height, color }` to opt in. Honors world
    position, uniform scale, rotation, and opacity.
  - `PointRenderer.addRect(...)`: rectangles are batched as an expanded triangle
    list (6 vertices/rect, rotation applied on the CPU) and drawn with one
    `drawArrays(TRIANGLES)`, alongside the existing `gl.POINTS` circles.

  Only active with `pointBackend: 'webgl'`; otherwise these entities render
  normally. Benchmarked ~1.9× over Canvas2D at 100k rects. (Implemented as a
  triangle batch rather than instanced quads, which were dramatically slower on
  software GL while equivalent on hardware.)

- f68ade4: Curve-accurate hit-testing for `SplineEntity`, and a new `Entity.getWorldScale()`.

  - `SplineEntity` now picks against the actual curves by default: a point hits
    only within `lineWidth/2 + hitTolerance` of a flattened Bézier (cached), instead
    of anywhere in the bounding box. Options: `hitTest: 'curve' | 'aabb'` (default
    `'curve'`) and `hitTolerance` (extra local-unit pick padding).
  - Fixes a scale bug: `isPointInside` now maps the world point into the entity's
    unscaled local space via the new `Entity.getWorldScale()`, so hit-testing is
    correct for scaled/nested splines (previously the click area didn't track the
    visual size under scale).

  Note: `'curve'` is the new default, so clicks between strokes inside the bounding
  box no longer register — pass `hitTest: 'aabb'` for the old behavior.

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
