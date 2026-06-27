# @vecto-ui/core

## 0.6.0

### Minor Changes

- aa5e473: MSDF hardware-accelerated text and off-main-thread layout.

  - **`MSDFFont`**: multi-channel signed-distance-field font model with an O(1) Unicode→glyph lookup, so text stays vector-sharp under arbitrary scale/rotation.
  - **`MSDFTextEntity`**: a WebGL render path (median + `fwidth` edge filtering and packed-color unpacking in the shader) with a zero-GC Canvas 2D fallback.
  - **`LayoutWorkerManager`**: runs the `LayoutEngine` in a Web Worker (inlined, zero external reference) with leading-edge debounce and deferred Object-URL teardown, so reflow of large documents never blocks the render thread.

- 2512008: feat(core): make SplineEntity interactive by default and add showBounds

  - SplineEntity now sets `interactive = true` in its constructor so the
    a11y shadow layer creates a shadow DOM node and dispatches pointer
    events (click, pointerdown, hover, pointerleave) through the entity
    tree. Previously consumers had to manually set this.
  - Added `showBounds: boolean` property (defaults to `false`). When
    toggled on, `render()` draws a rounded-rect outline of the entity's
    local bounding box — useful for drag feedback and debugging hit areas.
    The outline follows the entity's transform (rotation, scale) naturally
    since it is drawn in local space.

### Patch Changes

- c98d3e3: Add `Scene.a11ySyncInterval` to throttle the accessibility/automation shadow-DOM sync.

  By default the shadow layer syncs every rendered frame. Under heavy animation those per-frame DOM writes (position/size/attr updates) can drag Canvas FPS. Set `a11ySyncInterval` (ms, e.g. `100`) — via `SceneOptions` or the property — to cap the sync rate; the a11y/automation layer stays eventually consistent while the render loop keeps its frames cheap. Default `0` preserves the every-frame behavior.

- 8faa813: Fix `parseColorToRGBA` color parsing so the WebGL/sprite backends match Canvas 2D:

  - **Percentage alpha** (`rgba(255, 0, 0, 50%)`) now resolves to `0.5` instead of `50`.
  - **Modern CSS Color 4 syntax** — whitespace-separated channels with slash alpha (`rgb(255 0 0 / 50%)`, `rgb(0 0 0 / 0.25)`) — now parses directly instead of falling back to a 1×1 canvas (and silently turning black under SSR).
  - **Out-of-range values** are clamped to `[0, 1]` (`rgb(300, -5, 0)` → `[1, 0, 0, 1]`), matching how CSS and Canvas 2D treat them, so the GPU path no longer receives `>1` channels.

- 668e503: Add DOM-style event propagation (capture + bubble) to the entity tree.

  `Scene` now dispatches forwarded pointer/wheel/click events through a `VectoUIEvent` that walks the tree: a capture phase (root→target) then a bubble phase (target→root). Handlers get `target`, `currentTarget`, `stopPropagation()`, `stopImmediatePropagation()`, and `preventDefault()`; common native fields (`deltaY`, `clientX`, `key`, …) pass through, so existing handlers keep working.

  - `Entity.on(type, cb, { capture })` registers a capture-phase listener (bubble is the default).
  - `Entity.dispatchEvent(event)` runs the capture/bubble walk; `emit(type, payload)` stays a direct, self-only dispatch (back-compat, used for component-internal events like a control's own `change`).
  - enter/leave (`hover`/`pointerleave`) don't bubble, matching the DOM; click/pointer/wheel do — so an ancestor (e.g. a draggable list) can react and stop a descendant's event.

- 382e34f: Text flow around exclusion rects (战役一, PR B — "文字绕流" v1): text can now wrap around rectangular regions, like CSS floats.

  - **`@vecto-ui/core`**: new pure `computeLineSegments(top, bottom, maxWidth, exclusions)` returns the free horizontal segments left on a line after subtracting the `ExclusionRect`s that overlap its band (left/right floats narrow the line; a centered rect splits it in two; a full-width one skips the band). `LayoutEngine.layoutPrepared` takes an optional third `exclusions` argument and flows words across those per-line segments. New exports: `ExclusionRect`, `LineSegment`, `computeLineSegments`. The single-column path (no exclusions) is byte-for-byte unchanged.
  - **`@vecto-ui/ui`**: `RichText` gains an `exclusions` option and a `setExclusions()` method.

- b5e2c76: Inline rich-text flow (战役一, PR A): bold / italic / colored / differently-sized runs that flow and wrap on the same lines, sharing a baseline.

  - **`@vecto-ui/core`**: new `LayoutEngine.prepareRich(spans, atlas, baseFontSize, baseStyle?)` cold pass taking `StyledSpan[]`. Each grapheme carries the (base-merged) `TextStyle` of the span it came from — so a style change _mid-word_ is honored — and is measured at its run's `fontSize`. `layoutPrepared` now baseline-aligns mixed sizes (tallest run on a line drives line height; smaller glyphs drop to the shared baseline) and carries `style` onto each `LayoutNode`. New exports: `TextStyle`, `StyledSpan`; `PreparedGlyph`/`LayoutNode` gain an optional `style`. Plain (single-style) layout is unchanged.
  - **`@vecto-ui/ui`**: new `RichText` component — renders styled runs via the engine's rich path, drawing each glyph with its run's color and weight/slant.

- 90a4339: Inline links in rich text (战役一, PR A.5): a `{ href }` run in a `RichText` is underlined and painted in the link color on the canvas, and projects a real, operable `<a href>` shadow node so screen readers announce it and automation agents (Playwright / AI) can find it by href and click it — routing back to `onLinkClick`.

  - **`@vecto-ui/core`**: new public `Scene.detachA11y(entity)` to prune the shadow node(s) of an entity subtree on demand. Interactive _child_ entities (e.g. per-link hotspots) call this when they are removed, so the per-frame `syncA11y` (which only creates/updates) never leaks stale nodes.
  - **`@vecto-ui/ui`**: `RichText` gains `linkColor` and `onLinkClick` options. Each contiguous `href` run gets one transparent `<a>` hotspot child, kept stable across re-wrap (one per run) and pruned when the links change. Link glyphs render with the link color plus an underline.

- 2a20b15: Memoize `LayoutEngine.prepare()` at the paragraph level for fast incremental / streaming text.

  `prepare()` rebuilt the whole `PreparedText` on every call, so streaming text (AI tokens, live logs) that re-prepares a growing string paid `O(document)` segmentation/measurement per update. Paragraphs are now memoized by `fontSize + text`, so unchanged paragraphs are reused by reference and only the changed one is rebuilt — per-update cost drops to `O(changed paragraph)`. The cache is invalidated when the font atlas changes, keeping glyph widths correct.

- 6ad07c7: Make the core SSR / no-DOM safe (bottleneck: implicit Shadow-DOM dependence).

  `Scene` and `CanvasRenderer` no longer hard-require browser globals at construction, so the engine's logic is usable in Node/Bun (headless layout, server-side export) without jsdom:

  - `Scene` only builds the a11y/automation shadow layer when `document` exists; otherwise it degrades to a no-op (`a11yRoot = null`, `syncA11y` early-returns). `window` listeners and `requestAnimationFrame` reschedules are guarded too, so construct / tick / `destroy` never throw when those globals are absent.
  - `CanvasRenderer` reads `devicePixelRatio` / viewport via guards, falling back to the canvas's own size, and tolerates a null 2D context.

- cd28e58: Streaming / typewriter rich text (战役一, PR C — "流式打字机"): re-laying out a growing styled document is now O(changed paragraph) instead of O(document).

  - **`@vecto-ui/core`**: `LayoutEngine.prepareRich` now memoizes per paragraph (mirroring the plain `prepare` memo), keyed by `fontSize` + text + a _value_-based run-length signature of the inline styles. A streaming caller that appends styled runs reuses every untouched leading paragraph by reference — even if it passes fresh style objects with the same values. The memo is invalidated when the font atlas changes.
  - **`@vecto-ui/ui`**: `RichText.appendSpans(spans)` and `Text.append(text)` for incremental streaming; both re-lay out through the paragraph memo.

- 7a702a8: Add a multi-line `TextArea` component (战役二).

  - **`@vecto-ui/ui`**: new `TextArea` — a multi-line field backed by a real, transparent `<textarea>` shadow node. The browser owns editing (keyboard, IME composition, selection, clipboard, undo, multi-line navigation); the canvas mirrors it, re-wrapping the value and drawing text, cross-line selection, and a blinking caret with vertical scroll-to-caret. Exposes a pure `wrapText(value, maxWidth, measure)` helper (offset-aware line wrapping with hard-newline + char-level breaking) and `lineOfOffset()` for caret mapping.
  - **`@vecto-ui/core`**: the a11y/automation shadow layer now supports `tag: 'textarea'` — `Scene.syncA11y` projects a `<textarea>`, sets its placeholder, syncs its value, and forwards its `input`/`change`/selection/IME events back to the entity (previously only `<input>` was wired).

- c1aebf2: Add touch / pointer-drag support.

  - `core`: `Scene` calls `setPointerCapture` on `pointerdown` and releases it on `pointerup`, so a drag keeps receiving `pointermove`/`pointerup` after the pointer leaves the node's box; interactive shadow nodes get `touch-action: none` so the browser doesn't claim touch drags (the canvas owns its gestures).
  - `ui`: `ScrollView` now scrolls by pointer-drag (touch & mouse), not just the wheel — content follows the finger 1:1 and clamps to the content bounds. The wheel/drag clamping is shared in one helper.

## 0.5.3

### Patch Changes

- ac8b159: Support full-viewport / boundless interactive entities in the a11y layer.

  Add `Entity.a11yFullViewport`: an interactive entity with no intrinsic box
  (`width`/`height` of `0`) — e.g. an infinite-canvas graph — can now opt into a
  viewport-filling shadow node so it receives global pointer events. Previously
  `Scene.syncA11y` skipped any entity with `width === 0`, so such surfaces lost all
  DOM-routed pointer events. The full-viewport node mounts behind all other shadow
  nodes, so on-top components stay clickable, and uses the default cursor.

- 59a2b64: Add power-saving render controls to `Scene`.

  - `Scene.maxFPS` (and `SceneOptions.maxFPS`): cap the render loop to N frames per
    second (`0` = uncapped). Continuous animations still run, just less often —
    fewer GPU/CPU cycles (e.g. a quieter fan in a library). The loop skips frames
    that arrive sooner than the target interval; `dt` stays accurate because
    `lastTime` only advances on rendered frames.
  - `respectReducedMotion` (default `true`): a system **prefers-reduced-motion**
    setting auto-caps the loop to `REDUCED_MOTION_FPS` (30), or the lower of that
    and `maxFPS`. Also an accessibility win. Set `false` to ignore the OS setting.

- c1d428f: Add a scrollable viewport (`ScrollView`) with clipping + wheel scrolling.

  - `core`: `Entity.clipChildren` (Scene clips a node's children to its local box) and a forwarded `'wheel'` event from the shadow node (non-passive, so a scroll container can `preventDefault()` the page scroll).
  - `ui`: `ScrollView({ width, height })` — nests children in a clipped content layer, scrolls on wheel with a damped spring, and clamps to the content bounds. Unblocks scrollable docs/long-list pages built with VectoUI.

- 7f5e403: Add MSDF (multi-channel signed distance field) GPU text rendering to the WebGL backend.

  - `MSDFFont` parses the `msdf-atlas-gen` JSON layout and lays a string out into positioned quads (em→px geometry, atlas→UV with `yOrigin` flip, kerning, `\n`, letter spacing, codepoint-aware).
  - `PointRenderer.setMSDFTexture(source, distanceRange)` + `addGlyph(...)` draw those quads as one `TRIANGLES` batch with the Chlumsky median/`fwidth` shader, so glyphs stay crisp at any scale. Kept separate from the `setTexture`/`addSprite` atlas so both can be active.

- 9d587db: Add texture-atlas sprite support to the WebGL point layer.

  `PointRenderer` gains `setTexture(source)` and `addSprite(x, y, w, h, u0, v0, u1,
v1, color?, alpha?, rotation?)`: a textured-quad triangle batch that samples a
  texture atlas with a multiply tint, drawn in one `TRIANGLES` call. This lets large
  sets of custom glyphs / icons (e.g. emoji, `@`-style nodes) render on the GPU
  instead of falling back to Canvas2D. `addSprite` is a no-op until a texture is set.

## 0.5.2

### Patch Changes

- 715693b: Fix: Add keyboard accessibility (tabindex and Enter/Space keydown events) for non-natively focusable elements with interactive roles (like `role="switch"`) in the a11y shadow DOM.
- 7c9e40c: Docs: rewrite READMEs for accurate positioning and honest, reproducible numbers.

  Removes the fabricated "React vs core" comparison table (1k/10k/100k → React
  "Crash" vs "60 FPS") and the misleading "60 FPS with 100,000+ entities" tagline.
  READMEs now describe VectoUI as a Zero-DOM canvas UI runtime with the a11y/agent
  moat, cite measured benchmark numbers, list the full component set, document the
  IME-capable `Input`, and state where the framework does and doesn't fit.

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
