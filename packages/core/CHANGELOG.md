# @vectojs/core

## 1.9.1

### Patch Changes

- 0ab7364: Clear stale optional native and ARIA state from existing accessibility shadow
  elements when an entity stops returning that attribute. Dynamic disabled,
  checked, expanded, selected, relationship, range, role, and label state now
  tracks the current VMT contract instead of retaining a previous frame's value.

## 1.9.0

### Minor Changes

- d772197: Add concrete primitive entities and two base-class ergonomics, so common shapes and grouping no longer require a bespoke `Entity` subclass.

  - `Rect` — an axis-aligned rectangle primitive (`RectOptions`: `width`/`height`/`fill`/`stroke`/`strokeWidth`/`radius`), drawn from its local origin `(0,0)`. Its `width`/`height` match the drawn box so the a11y shadow node lines up. A plain solid-fill, square-cornered, unstroked `Rect` opts into the WebGL instanced-rect fast path via `getBatchRect`; rounded/stroked rects use the Canvas path.
  - `Circle` — a circle primitive centered on its local origin (`CircleOptions`: `radius`/`fill`/`stroke`/`strokeWidth`). Its a11y box is the bounding square offset by `-radius` so it covers the disc. A plain solid-fill (unstroked) `Circle` opts into the point-batch fast path via `getBatchCircle`.
  - `Group` — a transform-only container that draws nothing and is transparent to hit-testing (children stay independently interactive), for composing one transform onto a set of children. Accepts children inline: `new Group(a, b, c)`.
  - `Entity.set(props)` — assign several own properties in one chained call, each through its normal setter (so configured transitions still animate). Typed `Partial<this>`.
  - `Entity.add(...children)` — `add` is now variadic; `parent.add(a, b, c)` attaches all three in order. The single-child call is unchanged.

  All additive and backward-compatible; `Entity` remains abstract and existing subclasses are untouched.

## 1.8.0

### Minor Changes

- d87add3: Share one source-aware prepared grid between CodeBlock canvas paint and semantic DOM projection. Grid geometry now preserves UTF-16 source ranges, grapheme clusters, tab stops, wide CJK/emoji cells, Arabic shaping, and bidi visual positions while retaining exact native copy/find text.

  Calibrate projected grapheme carriers after font loading so Firefox font substitution, DPR, CSS zoom, transforms, and forced colors keep selection geometry aligned without synchronous layout reads in the projection hot path. Text-selection routing now uses prepared local caret boundaries for ink and blank regions, preserves Shift/word/line/reverse selection semantics, cleans up rebuilds and lost mouse releases, and keeps structural Table semantics from intercepting selectable cell projections.

  Route ordinary Text, RichText, and line-less custom projections through transformed two-dimensional grapheme caret geometry, including rotated, mirrored, and non-uniformly scaled content.

  Recalibrate prepared grids after viewport or browser zoom changes. Cold probes now inherit the projection's zoom context and compensate Firefox missing-glyph Range metrics, including CJK fallback at fractional DPR and zoom, while hidden grids retain the same source geometry when revealed.

  Deduplicate cold font samples and reuse each line's source segmentation. On the release workstation, the 80,000-input-cluster preparation mean fell from 247.16 ms to 65.08 ms for ASCII and from 265.88 ms to 77.77 ms for mixed Unicode. `@vectojs/ui` 1.9 requires `@vectojs/core` 1.8 or newer within the 1.x line.

## 1.7.1

### Patch Changes

- Fix text selection and CodeBlock rendering

  **@vectojs/core**

  - Fix text selection not starting from whitespace/padding regions within selectable entities (e.g. CodeBlock padding area). Removed `overflow: hidden` from content projection divs — the a11y overlay root handles viewport clipping.
  - Fix selection disappearing when the mouse is dragged outside an entity's bounds. The a11y root now temporarily promotes to `pointer-events: auto` during an active selection drag so the browser can extend the Selection Range across entity boundaries, matching native DOM selection behavior.

  **@vectojs/ui**

  - Fix CodeBlock character spacing collapse on Firefox desktop. Firefox's Canvas2D applies OpenType ligatures to monospace fonts, causing `measureText('office')` to return the ligated `ffi` width instead of 6 × cellWidth. CodeBlock now uses pure grid positioning (character count × cell width) instead of the hybrid `Math.max(grid, measured)` approach, eliminating cross-browser rendering differences.

## 1.7.0

### Minor Changes

- c39a440: Preserve logical source text and native selection geometry across positioned multiline content projections. Visual line separators now belong to their preceding line instead of creating root-origin selection fragments; Text and RichText keep soft wraps, hard breaks, CJK, ligatures, and RTL source order intact; CodeBlock uses a platform monospace-first fallback. Chromium and Firefox browser coverage now includes keyboard copy/paste, Noto Serif substitution, forced colors, DPR and zoom variants, Markdown lists and tables, and standalone Table cells.

## 1.6.2

### Patch Changes

- f3206f9: Allow interactive entities to declare and dynamically update an explicit semantic `tabIndex` for focusable canvas workspaces and other non-control keyboard regions.

## 1.6.1

### Patch Changes

- e282f2f: Route browser pointer cancellation through projected entities and DOM portals, release projected pointer capture safely, and retain cancellation in DevTools event traces.

## 1.6.0

### Minor Changes

- 38b3b8b: Align selectable DOM text and native editor shadows with Canvas 2D baselines, including explicit visual-line projections for mixed typography and code blocks.

## 1.5.0

### Minor Changes

- fc96dfa: Make browser-native text selection a reusable VectoJS contract. Core now keeps dynamically
  materialized content projections in VMT order, removes them with their subtree, hides projections
  outside clipping ancestors, and exposes `Scene.getContentElement()` for tooling. UI adds
  configurable selection to Text, RichText, Markdown, CodeBlock, and Table cells; projects fenced
  code; preserves RichText wrap points; and gives Table an explicit, render-pure layout pass with
  wrapped, single-owner cell projections. UI's Core peer range is also aligned with its stable API
  contract (`>=1.0.0 <2.0.0`). DevTools event traces now report `source: "content"` for events
  originating on projected selectable text.

## 1.4.1

### Patch Changes

- Scene: `detachA11y`/`Entity.remove()` now prunes content-projection nodes for the whole removed subtree, not just the top entity. A removed container's descendant text projections used to outlive it — still selectable (`pointer-events: auto`), still find-in-page-able at their stale position, and leaking DOM nodes.

## 1.4.0

### Minor Changes

- fix(core): sort a11y content projection DOM nodes properly in the Shadow DOM overlay to allow continuous multi-block text selection

## 1.3.0

### Minor Changes

- Support projecting `target` attribute to accessibility DOM node in `@vectojs/core`. Render MathJax SVGs with intrinsic dimension measurements to maintain responsive sizing in `@vectojs/ui`. Map `target="_blank"` on links to prevent canvas escape in interactive modes.

## 1.2.0

### Minor Changes

- fe162c8: - Fix massive memory leak in `Entity.remove()` causing A11y DOM nodes to orphan and leak memory.
  - Upgrade `Table` to support `Entity` children allowing for inline Markdown styling inside cells.
  - Fix `MarkdownView` FPS drops during streaming by dynamically throttling AST evaluations.

## 1.1.0

### Minor Changes

- - Fix massive memory leak in `Entity.remove()` causing A11y DOM nodes to orphan and leak memory.
  - Upgrade `Table` to support `Entity` children allowing for inline Markdown styling inside cells.
  - Fix `MarkdownView` FPS drops during streaming by dynamically throttling AST evaluations.

## 1.0.0

### Major Changes

- First stable release. All core engine features (scene graph, layout, hit-testing, animation drivers, WebGL/WebGPU/Canvas2D/SVG rendering, accessibility projection, text shaping/bidi) and the full UI component set have shipped and been through a complete file-by-file audit of both packages, with a live-interaction QA pass across every demo and renderer backend. No known bugs or vulnerabilities remain open.

  This is a semver commitment: breaking changes to the public API of either package now require a major version bump.

## 0.2.9

### Patch Changes

- c10d401: Bound `parseColorToRGBA`'s cache to the same 1000-entry LRU pattern already used by `@vectojs/ui`'s `measureText` cache. `BatchCircle`/`BatchRect` colors are read every frame, so a workload with many distinctly-colored, continuously-varying entities (an animated heatmap, a particle field with per-point color shifts) could mint a new unique color string every frame — the cache had no eviction and would grow unbounded for the life of the page.
- 1af6c8f: Fix `Entity.add()` not detaching a child from its previous parent: adding the same child to a parent twice duplicated it in `children[]` (a single `remove()` call only strips the first occurrence, leaving a stale entry that keeps rendering/updating despite `child.parent` reporting `null`); re-parenting to a different entity without an explicit `remove()` first left the old parent holding a stale reference whose own `.parent` disagreed with where the child now actually lived. `add()` now detaches from any existing parent first — the same convention Three.js's and PixiJS's `add`/`addChild` already follow. The check is O(1) for the common case of adding a brand-new entity.
- f64823d: Fix `getWorldTransform()`/`getWorldScale()`/`getWorldRotation()` silently dropping every transform above an ancestor whose `id` happened to equal the string `'root'`. Scene's own root entity is internally named that, but `id` is a plain user-settable string with no reservation — any caller who names their own top-level container `"root"` (an entirely ordinary choice) would have any entity nested under it lose its parent's position/scale/rotation contribution entirely. Now walks to the true top of the tree (`.parent === null`) instead of matching on `id`.

## 0.2.8

### Patch Changes

- d00abdd: New package @vectojs/devtools: the in-page Virtual Math Tree inspector — live tree view with type/geometry/animation badges, one-shot entity picking, world-transform readout, keyboard nudge editing, and a host-overlay selection highlight; the panel itself is rendered with VectoJS. Core gains read-only Scene.rootEntity/overlayRootEntity accessors for tooling.
- 8da5d8c: Engine cleanups: WebGL circles that gl.POINTS cannot represent (center near/off the viewport edge, or diameter beyond the GPU point-size cap) now render through a triangle-quad fallback instead of popping or shrinking; the Scene loop no longer re-walks the tree up to 4x per tick (animation/interactive flags are collected during the render walk); legacy animate() wakes idle onDemand scenes; ThreeRenderer caches drawImage textures per source with an invalidateImage() API.
- 8bc6c2b: Typography: LayoutEngine gains textAlign 'justify' (stretches inter-word spaces, or inter-character gaps on space-less CJK lines, so wrapped lines end flush; paragraph-final lines stay ragged) and wrap-time hyphenation — soft hyphens (U+00AD) break with a visible '-' out of the box, and a pluggable hyphenate hook supplies break parts for plain words. TextEntity exposes setTextAlign()/setHyphenator().

## 0.2.7

### Patch Changes

- 965822d: Static content projection: entities can expose rendered text via getContentProjection() and the Scene mirrors it as transparent, position-synced, viewport-lazy DOM nodes — canvas text becomes findable (Ctrl+F), readable by screen readers and crawlers, translatable, and optionally natively selectable. TextEntity and MSDFTextEntity opt in out of the box; disable per scene with contentProjection: false.
- HiDPI fixes: embedded canvases no longer display at double size on DPR-2 screens (the renderer now records the logical size as CSS size), and remounting a Scene on the same canvas no longer compounds the devicePixelRatio scale. A real-Chromium e2e leg at deviceScaleFactor 2 now guards these paths in CI.

## 0.2.6

### Patch Changes

- f4c98f3: markDirty() calls made inside update() now survive to the next frame instead of being wiped at end of tick; CPU-fallback particles render and simulate in a consistent coordinate space for transformed entities; Entity.destroy() settles pending animateTo/springTo promises; SVGRenderer.arc matches Canvas sweep semantics for CCW and wrapped arcs; MSDF text wrap width is configurable via maxWidth/setMaxWidth.
- e45ec38: Fix animation/runtime latent bugs found in the 2026-07-06 full-source review:

  - `SpringPhysics` now integrates in clamped substeps — a background-tab rAF gap (multi-second dt) no longer catapults spring-animated entities off-screen.
  - `Scene` onDemand frame skipping no longer silently disables itself when `autoThrottle: false` is set.
  - Layout worker: multi-line text now reports the widest line's width (was: last line), wraps whole words (with per-glyph breaking for CJK/long words), honors `\n`, and swallows the wrapping space; glyph advance lookup is now O(1).
  - WebGL point layer: identical texture sources are no longer re-uploaded every frame; switching MSDF atlases mid-frame commits the pending glyph batch first (two fonts no longer render with one atlas); the GL canvas now composites with `premultipliedAlpha: false` matching its straight-alpha blending (no more bright AA fringes).
  - `MSDFTextEntity` GL path now honors ancestor opacity.
  - `SplineEntity` gradient documents bypass the bitmap cache (gradients rendered as `defaultColor` before) and solid-color bakes are DPR-scaled (no more blurry cached splines on HiDPI).
  - `colorParse` clears its shared 1×1 canvas before each fallback parse (semi-transparent named/hsl colors no longer blend with the previous parse).
  - Legacy `Entity.animate()` writes past the property setters, so it no longer spawns/retargets transition drivers every frame when `setTransition` is configured on the same property.
  - `Scene.destroy()` releases the WebGPU device; `Scene.resize()` resizes the WebGPU particle canvas; removing the last `ComputeParticleEntity` clears the GPU canvas instead of freezing the final frame.
  - Embedded scenes (`disableWindowResize`) keep the canvas's own dimensions — `CanvasRenderer` no longer clobbers them to the window size.
  - New optional `IRenderer.present()` hook: `Scene` calls it once at the end of each render pass so retained-scene backends can do their single real GL render there.

## 0.2.5

### Patch Changes

- Preserve full grapheme clusters in LayoutEngine nodes so canvas text labels keep astral emoji intact.

## 0.2.4

### Patch Changes

- Fix form-control redraws in on-demand scenes, stabilize CodeBlock spacing, and keep resizable panel sizes bounded after resize.

## 0.2.3

### Patch Changes

- Stabilize renderer and Scene lifecycles. Core now provides exact nested coordinate conversion and
  world bounds, modifier-aware events, inherited opacity on every backend, CSS-aligned semantic and
  portal overlays, pure and SVGEntity-aware vector snapshots, recoverable layout workers, safe
  navigation URLs, escaped SVG output, recursive Scene teardown, and idempotent renderer disposal.

## 0.2.2

### Patch Changes

- Add `@vectojs/video-exporter` for rendering scenes to MP4 videos. Expose `Scene.step(dt)` in `@vectojs/core` for deterministic clock control.

## 0.2.1

### Patch Changes

- 40182bd: Fix choppy/stepped motion for any in-flight `setTransition`/`animateTo`/`springTo` animation in the default `always` render mode: `Entity.hasPendingAnimations()` didn't check active property drivers, so once Scene's idle auto-throttle engaged, an animation only advanced one frame per external `markDirty()` call instead of every render frame (a `markDirty()` called from inside `update()` is wiped by the loop's own `dirty = false` at the end of that same tick — only `hasPendingAnimations()` reliably holds the throttle off across frames).

  `ScrollView` is refactored to drive its content's scroll offset through this shared, dt-aware spring system instead of a hand-rolled, frame-rate-dependent integrator, fixing both the throttle-invisibility and the dt-independence in one pass. This is most visible in the AI Chat demo, where scrolling now glides continuously alongside token-by-token streaming instead of stepping in bursts synchronized to token arrival.

## 0.2.0

### Minor Changes

- 21cea39: Add a unified, spring-first animation system.

  `@vectojs/core` gains an easing library (`Easing`), per-property spring/tween
  drivers, and a declarative + imperative API on `Entity`: `setTransition` (assign
  a configured property and it animates), plus `animateTo` / `springTo` (imperative,
  Promise-returning). The six transform/visual properties (`x`, `y`, `scaleX`,
  `scaleY`, `rotation`, `opacity`) are now accessors with a zero-overhead fast path
  when no transition is configured (benchmarked: 5000 writes/frame ≈ 89µs, 0.5% of a
  60fps budget). Legacy `Entity.animate()` is preserved. Adds an `onMounted`
  lifecycle hook and honors `prefers-reduced-motion` (movement snaps, opacity fades).

  `@vectojs/ui` gains a shared enter/exit presence helper on `UIComponent`
  (`enterMotion` / `exitMotion` / `dismiss`). `Modal` and the `Overlay` family
  (`Tooltip` / `Popover` / `ContextMenu`) now animate through the shared system,
  replacing their bespoke `SpringPhysics` and hand-rolled lerps.

## 0.1.0

### Minor Changes

- c74bb7bd: Renamed from `@vecto-ui/core` to `@vectojs/core` (the GitHub org uses "vectojs";
  `vecto-ui` wasn't available) and reset the version to `0.1.0` for the new scope's first
  release. `publishConfig.access` is now set explicitly, since a new scope defaults to
  private on first publish. `VectoUIEvent` was also renamed to `VectoJSEvent`.

  This is a clean version reset, not a feature release — no source behavior changed. See
  **Pre-rebrand history** below for everything that shipped under the old `@vecto-ui` name.

---

## Pre-rebrand history (`@vecto-ui/core`)

Everything below shipped under the old `@vecto-ui` npm scope, before the 2026-07-01 rename
and version reset. Kept for historical reference — none of these version numbers exist under
the current `@vectojs/core` scope.

## 0.9.2

### Patch Changes

- Refactor core package into modular subpath exports (`./layout`, `./renderer`, `./text`) and introduce static registration APIs (`Scene.registerWebGLPointRendererCreator`, `Scene.registerWebGPUParticleSystemManager`) for pluggable backends.

## 0.9.1

### Patch Changes

- Fix WebGPU particle vertex storage binding and align CPU/GPU spring limits. Adjust Scene maxFPS to default to 60 with idle auto-throttling. Fix ScrollView stability and expose public scroll APIs. Add GFM Table support to Markdown component. Adjust UI peerDependencies.

## 0.9.0

### Minor Changes

- Add high-performance WebGPU Compute-Shader based particle system simulation and UAX #9 compliant bidirectional (BiDi) text layout engine with Arabic/Hebrew/Persian contextual shaping, along with caret navigation and visual highlights in Input and TextArea.

## 0.8.0

### Minor Changes

- feat(particles): implement WebGPU compute-driven particle system with GPU-side physics simulation (WGSL) for 1,000,000+ particles, zero-copy buffer-less procedural quad rendering, automatic fallback to WebGL2/Canvas2D CPU integration, and robust GPUDevice lost recovery with exponential backoff.

## 0.7.1

### Patch Changes

- feat(a11y): strengthen a11yRoot with strict DFS DOM ordering, typing synchronization protection, and full WAI-ARIA keyboard navigation for Dropdown.
- cd3e3e8: feat(three): implement optimized ThreeAdapter with dynamic rendering intercept, multi-pointer WebXR support, and robust resource disposal.

## 0.7.0

### Minor Changes

- 3dfbfd4: DOM Portal + SVG entities — bridge native DOM and vector graphics into the canvas scene (战役二).

  - **`DOMPortalEntity`**: mounts a real HTML element (iframe, video, third-party widget…) into the Vecto coordinate space. It forwards native `click`/`pointer*`/`wheel` into the entity tree as `VectoJSEvent`s (with capture-phase `focus`/`blur`), caches its measured size via a `ResizeObserver` to avoid forced reflow on hit-testing, and is a leaf (guards against adding canvas children).
  - **`SVGEntity`**: renders an SVG source (e.g. LaTeX/Mermaid output) with dynamic level-of-detail re-rasterization — debounced on scale change, with a cached parsed document, and a browser/SSR-safe dimension parser.
  - **`Scene`**: unified stacking — DOM portals mount under `a11yRoot` and share one depth-ordered `zIndex` pass with the a11y shadow nodes (fixes the a11y layer hijacking portal clicks); portals are pre-cull aligned and reconciled safely across scenes.
  - **`Entity.getWorldRotation()`**: accumulated world-space rotation up the parent chain.

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

  `Scene` now dispatches forwarded pointer/wheel/click events through a `VectoJSEvent` that walks the tree: a capture phase (root→target) then a bubble phase (target→root). Handlers get `target`, `currentTarget`, `stopPropagation()`, `stopImmediatePropagation()`, and `preventDefault()`; common native fields (`deltaY`, `clientX`, `key`, …) pass through, so existing handlers keep working.

  - `Entity.on(type, cb, { capture })` registers a capture-phase listener (bubble is the default).
  - `Entity.dispatchEvent(event)` runs the capture/bubble walk; `emit(type, payload)` stays a direct, self-only dispatch (back-compat, used for component-internal events like a control's own `change`).
  - enter/leave (`hover`/`pointerleave`) don't bubble, matching the DOM; click/pointer/wheel do — so an ancestor (e.g. a draggable list) can react and stop a descendant's event.

- 382e34f: Text flow around exclusion rects (战役一, PR B — "文字绕流" v1): text can now wrap around rectangular regions, like CSS floats.

  - **`@vectojs/core`**: new pure `computeLineSegments(top, bottom, maxWidth, exclusions)` returns the free horizontal segments left on a line after subtracting the `ExclusionRect`s that overlap its band (left/right floats narrow the line; a centered rect splits it in two; a full-width one skips the band). `LayoutEngine.layoutPrepared` takes an optional third `exclusions` argument and flows words across those per-line segments. New exports: `ExclusionRect`, `LineSegment`, `computeLineSegments`. The single-column path (no exclusions) is byte-for-byte unchanged.
  - **`@vectojs/ui`**: `RichText` gains an `exclusions` option and a `setExclusions()` method.

- b5e2c76: Inline rich-text flow (战役一, PR A): bold / italic / colored / differently-sized runs that flow and wrap on the same lines, sharing a baseline.

  - **`@vectojs/core`**: new `LayoutEngine.prepareRich(spans, atlas, baseFontSize, baseStyle?)` cold pass taking `StyledSpan[]`. Each grapheme carries the (base-merged) `TextStyle` of the span it came from — so a style change _mid-word_ is honored — and is measured at its run's `fontSize`. `layoutPrepared` now baseline-aligns mixed sizes (tallest run on a line drives line height; smaller glyphs drop to the shared baseline) and carries `style` onto each `LayoutNode`. New exports: `TextStyle`, `StyledSpan`; `PreparedGlyph`/`LayoutNode` gain an optional `style`. Plain (single-style) layout is unchanged.
  - **`@vectojs/ui`**: new `RichText` component — renders styled runs via the engine's rich path, drawing each glyph with its run's color and weight/slant.

- 90a4339: Inline links in rich text (战役一, PR A.5): a `{ href }` run in a `RichText` is underlined and painted in the link color on the canvas, and projects a real, operable `<a href>` shadow node so screen readers announce it and automation agents (Playwright / AI) can find it by href and click it — routing back to `onLinkClick`.

  - **`@vectojs/core`**: new public `Scene.detachA11y(entity)` to prune the shadow node(s) of an entity subtree on demand. Interactive _child_ entities (e.g. per-link hotspots) call this when they are removed, so the per-frame `syncA11y` (which only creates/updates) never leaks stale nodes.
  - **`@vectojs/ui`**: `RichText` gains `linkColor` and `onLinkClick` options. Each contiguous `href` run gets one transparent `<a>` hotspot child, kept stable across re-wrap (one per run) and pruned when the links change. Link glyphs render with the link color plus an underline.

- 2a20b15: Memoize `LayoutEngine.prepare()` at the paragraph level for fast incremental / streaming text.

  `prepare()` rebuilt the whole `PreparedText` on every call, so streaming text (AI tokens, live logs) that re-prepares a growing string paid `O(document)` segmentation/measurement per update. Paragraphs are now memoized by `fontSize + text`, so unchanged paragraphs are reused by reference and only the changed one is rebuilt — per-update cost drops to `O(changed paragraph)`. The cache is invalidated when the font atlas changes, keeping glyph widths correct.

- 6ad07c7: Make the core SSR / no-DOM safe (bottleneck: implicit Shadow-DOM dependence).

  `Scene` and `CanvasRenderer` no longer hard-require browser globals at construction, so the engine's logic is usable in Node/Bun (headless layout, server-side export) without jsdom:

  - `Scene` only builds the a11y/automation shadow layer when `document` exists; otherwise it degrades to a no-op (`a11yRoot = null`, `syncA11y` early-returns). `window` listeners and `requestAnimationFrame` reschedules are guarded too, so construct / tick / `destroy` never throw when those globals are absent.
  - `CanvasRenderer` reads `devicePixelRatio` / viewport via guards, falling back to the canvas's own size, and tolerates a null 2D context.

- cd28e58: Streaming / typewriter rich text (战役一, PR C — "流式打字机"): re-laying out a growing styled document is now O(changed paragraph) instead of O(document).

  - **`@vectojs/core`**: `LayoutEngine.prepareRich` now memoizes per paragraph (mirroring the plain `prepare` memo), keyed by `fontSize` + text + a _value_-based run-length signature of the inline styles. A streaming caller that appends styled runs reuses every untouched leading paragraph by reference — even if it passes fresh style objects with the same values. The memo is invalidated when the font atlas changes.
  - **`@vectojs/ui`**: `RichText.appendSpans(spans)` and `Text.append(text)` for incremental streaming; both re-lay out through the paragraph memo.

- 7a702a8: Add a multi-line `TextArea` component (战役二).

  - **`@vectojs/ui`**: new `TextArea` — a multi-line field backed by a real, transparent `<textarea>` shadow node. The browser owns editing (keyboard, IME composition, selection, clipboard, undo, multi-line navigation); the canvas mirrors it, re-wrapping the value and drawing text, cross-line selection, and a blinking caret with vertical scroll-to-caret. Exposes a pure `wrapText(value, maxWidth, measure)` helper (offset-aware line wrapping with hard-newline + char-level breaking) and `lineOfOffset()` for caret mapping.
  - **`@vectojs/core`**: the a11y/automation shadow layer now supports `tag: 'textarea'` — `Scene.syncA11y` projects a `<textarea>`, sets its placeholder, syncs its value, and forwards its `input`/`change`/selection/IME events back to the entity (previously only `<input>` was wired).

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
  - `ui`: `ScrollView({ width, height })` — nests children in a clipped content layer, scrolls on wheel with a damped spring, and clamps to the content bounds. Unblocks scrollable docs/long-list pages built with VectoJS.

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
  READMEs now describe VectoJS as a Zero-DOM canvas UI runtime with the a11y/agent
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
