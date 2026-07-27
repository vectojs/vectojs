# @vectojs/core

## 1.17.1

### Patch Changes

- b384024: Split the shared WASM loader's byte and network paths.

  `loadCoreWasmModule` accepted a union of raw bytes and URL/Response and handled
  both in one `compile()`, which let CodeQL trace file data (a test's `readFileSync`,
  or a bundler-emitted asset) into the `fetch` call and report
  `js/file-access-to-http` — "file data in outbound network request" (CWE-200).

  `compileBytes(BufferSource)` and `compileRemote(string | URL | Response)` are now
  separate, with dispatch at the call site, so bytes have no syntactic path to a
  network request. The per-backend loaders were already structured this way; the
  shared runtime introduced in 1.17.0 re-merged them.

  No behaviour change — every accepted source shape still works identically.

- de170fe: Project `required` as the native attribute on form controls.

  `A11yAttributes.required` only ever emitted `aria-required`. On an `<input>`,
  `<textarea>` or `<select>` the native `required` property is stronger: it
  participates in form validation and `:invalid` styling, which the ARIA attribute
  merely describes. Native controls now get `required`, and `aria-required` is left
  for elements with no native equivalent (e.g. `<div role="textbox">`), rather than
  both being set and risking drift.

## 1.17.0

### Minor Changes

- d25cbe2: Split the WASM animation gate per driver kind, and expose whether it opened.

  Spring and tween drivers have measurably different break-even points on the
  integrated path: spring and mixed workloads win ~1.4-2.3x from 128 active drivers,
  while pure tween is a **0.71x loss** at 128 and only turns net-positive near 256.
  One scalar `animDriverGateCount` therefore had to be set for the worse kind, which
  discarded the 128-255 spring win to avoid regressing a tween-heavy scene. The two
  counts were already tracked separately — only the threshold was shared.

  ```ts
  scene.animGate = { spring: 128, tween: 256, mixed: 128 }; // new defaults
  ```

  A frame with both kinds active uses `mixed`, since the batch is one call per kind
  and its economics track the combined count.

  `animDriverGateCount` still works: writing it sets all three, reading returns the
  tween (conservative) gate.

  Adds `Scene.animBatchedLastFrame`, which reports whether the batch path actually
  ran. `animBackend === 'wasm'` only means a backend is _installed_ — a gate above
  the driver count still ticks in JS, and conflating the two makes it easy to believe
  an accelerator is active when it never opens.

  Firefox remains a net loss at every count measured up to 16384, so these defaults
  are Chrome-oriented; on a Firefox-heavy audience leave animation batching off
  rather than tuning the gates.

- 447eb4f: Share one WASM instance per Scene across all four accelerators.

  Each `enableWasm*` previously instantiated `vectojs_core.wasm` itself, so a Scene
  enabling transforms, animation, hit-test and particles compiled the same binary
  up to four times and held four separate linear memories plus four sets of
  module-level statics. Nothing required that: the Rust crate already keeps those
  four stores in distinct statics, so they do not alias within a single instance.

  Now the compiled `WebAssembly.Module` is cached globally per URL source, and one
  `Instance` is created per Scene. Sharing a compile is safe; sharing mutable stores
  is not, so two Scenes still get separate instances.

  New public API:

  - `Scene.wasmRuntime` — the shared runtime, or `null`.
  - `Scene.setWasmRuntime(runtime)` — install a pre-built runtime so several Scenes
    can share one compile.
  - `loadCoreWasmModule`, `createCoreWasmRuntime`, `loadCoreWasmRuntime`,
    `clearCoreWasmModuleCache` from `@vectojs/core`.

  Behaviour is unchanged: every `enableWasm*` still returns `boolean`, still falls
  back to JS on any failure (CSP, 404, corrupt bytes, unsupported SIMD), and each
  accelerator keeps its own independent gate. A failed load is no longer cached, so
  one transient 503 cannot disable WASM for the page's lifetime.

  This is also the prerequisite for fusing transform -> AABB -> hit-grid inside one
  instance, which is what makes the cold hit-test path viable.

### Patch Changes

- 493370a: Stop shipping the rejected f32x4 benchmark kernel in the released WASM binary.

  `simd_f32_bench` was declared unconditionally and the crate had no `[features]`
  section, so the f32x4 compose prototype was compiled into every published
  `vectojs_core.wasm`. That kernel had already been measured and **rejected**: f32
  error accumulates along a transform chain (~93px on a deep tree), and it is not
  bit-comparable to the JS reference the differential suite is built on. It was dead
  weight in every download.

  It now sits behind a `bench-f32` Cargo feature, off by default. Measured saving:
  **36,816 → 33,792 bytes (3,024 bytes, 8.2%)**.

  `benchmarks/f32-simd-eval` still works, with an explicit build step:

  ```bash
  ./crates/vectojs-core-rs/build.sh --features bench-f32
  ```

  Run against a default build, the bench now reports the missing kernel and how to
  enable it, instead of failing on an undefined export several frames in.

- 6a0e942: Validate arguments in the raw WASM ABI instead of trusting the caller.

  The crate's exports take raw counts and dereference raw pointers, and their Safety
  contracts were enforced only by the TypeScript calling convention — `capacity`
  appeared 7 times against 21 `unsafe`/`static mut` sites, and the original Phase 1
  review already found two out-of-bounds read paths that way. The sandbox prevents
  such a bug corrupting the browser, but it can still trap, corrupt the module's own
  linear memory, or silently return wrong geometry and break a frame.

  `init` now records its allocated capacities, and `set_run_count`, `compose_scalar`,
  `compose_simd` and `compute_aabbs` return a status code instead of `void`:

  - `0` ok
  - `1` a count exceeded what `init` allocated
  - `2` a kernel ran before `init`
  - `3` a sibling run addressed a slot or parent outside the store

  A rejected call is a no-op, so it cannot half-write the store, and the JS side
  skips reading results back rather than copying stale matrices over the caller's
  data. Run-table validation uses checked arithmetic, so `start + len` cannot wrap
  past a naive bounds comparison, and negative `i32` fields are rejected before the
  cast to `usize` turns them into enormous indices.

  `WasmTransformBackend.lastStatus` exposes the most recent status, and
  `WASM_STATUS` is exported for comparisons. Arithmetic is unchanged — the guards
  only decide whether a kernel runs, not what it computes, so the differential tests
  still pass bit-exact.

- 49a7b3c: Re-acquire WASM typed-array views when a shared instance grows its memory.

  Sharing one instance per Scene means all four backends share one linear memory, so
  one backend's allocation can grow it and **detach every view built over the old
  buffer**. A detached `Float64Array` reports length 0 and returns `undefined` for
  every index, so the transform store silently appeared empty instead of failing.

  Verified directly against the binary: after `init(100000, …)` the world-matrix view
  is length 100008; after a subsequent `hit_init(…)` it is 0.

  `WasmTransformBackend.revalidateViews()` rebuilds the views when the buffer they
  were built over is gone, and the Scene calls it before writing transform inputs,
  before uploading local bounds, and before reading world AABBs. Without it, a Scene
  that enabled transforms _and_ hit-test would write every per-frame transform into a
  dead buffer.

  Also adds the fused hit-grid gather: with the transform store resident, the grid
  build reads world AABBs out of WASM memory instead of re-deriving four transformed
  corners per entity in JS. Measured on real hardware it is a **modest** 1.07-1.09x
  on Chrome and neutral-to-slightly-negative on Firefox — it does _not_ fix the cold
  hit-test path, whose cost is the JS pre-order walk and the grid build, not the
  corner arithmetic. `Scene.hitGatherPath` reports which gather ran.

## 1.16.3

### Patch Changes

- 75b06a3: Pin a11y projection gate symmetry and correct the `detachA11y` doc comment.

  Nothing tested what happens when an entity stops satisfying the projection gate
  (`interactive && (width > 0 || a11yFullViewport)`). Reading `syncA11y` alone
  suggests a leak, since it only creates and updates — but it is always followed by
  `enforceA11yDomOrder`, whose prune pass removes any element whose entity no longer
  qualifies. Measured: `interactive = true` projects, flipping to `false` removes the
  element on the next synced frame, and flipping back re-projects.

  Adds tests for each transition, including a zero-width collapse, the
  `a11yFullViewport` exception, and that focus moves to the sentinel rather than
  `<body>` when a _focused_ element is pruned.

  `detachA11y`'s doc said "the per-frame `syncA11y` only creates/updates, it never
  prunes", which is true of that method but reads as though removal never happens
  automatically. It now explains that the following order pass does prune, and that
  `detachA11y` is for the case that pass cannot see — a child dropped from a
  component's own bookkeeping while still parented, or discarded before the next
  sync.

  No behaviour change.

- 912cac2: Consolidate the a11y projection gate behind a single predicate.

  `interactive && (width > 0 || a11yFullViewport)` was inlined verbatim at four
  sites — `syncA11y` (create/update), `enforceA11yDomOrder` (which ids survive
  pruning), `getA11yTree` (the public snapshot) and `render` (reading-order and
  z-index assignment). Four copies of one rule is a standing correctness hazard: if
  any drifts, elements either leak (created but never marked active, so pruned and
  rebuilt every frame) or vanish from the semantic tree while still in the DOM. All
  four now call `shouldProjectA11y(node)`.

  The dev-mode leak warning counted with a _different_, approximate rule
  (`interactive && width > 0`), which undercounts `a11yFullViewport` nodes —
  projected at width 0 — and needed `+2` slack to avoid false positives. That slack
  also hid genuine one- and two-element leaks. It now uses the same predicate and
  compares exactly; its message says "projectable entities" rather than "interactive
  entities", which is what it always meant.

  No behaviour change for projection itself.

## 1.16.2

### Patch Changes

- a15f786: Draw all WebGL quad batches indexed (4 vertices + a shared static index buffer)
  instead of expanding each quad to 6 vertices.

  `flush()` already issues at most one draw call per primitive type, so draw-call
  count was never the cost — the submit path is bandwidth-bound. Every quad was
  uploading its two shared corners twice, which at 50,000 quads meant 9.16 MB per
  frame.

  Rects, sprites, glyphs and carved circle-quads now write 4 vertices and draw with
  `drawElements` against one `ELEMENT_ARRAY_BUFFER` built once and regrown
  geometrically (32-bit indices, since real scenes exceed the 16,383-quad ceiling a
  `Uint16Array` would impose). Upload volume drops by a third and the JS fill drops
  with it, since `writeQuad` writes 32 floats instead of 48.

  Measured on real hardware (`benchmarks/flush-upload`, RTX 4060 Laptop, work plus
  `gl.finish()`, median of 12), 6-vertex versus indexed:

  | quads   | Chrome          | Firefox          |
  | ------- | --------------- | ---------------- |
  | 12,000  | 0.61 -> 0.09ms  | 2.66 -> 1.47ms   |
  | 50,000  | 2.22 -> 0.87ms  | 9.02 -> 6.24ms   |
  | 100,000 | 12.62 -> 3.12ms | 16.81 -> 10.88ms |

  In the glyph path end to end (`benchmarks/glyph-batch`, 24,800 glyphs) the GPU
  submit went 1.57 -> 0.42ms on Chrome (3.7x) and 1.91 -> 1.20ms on Firefox (1.6x),
  with the JS accumulate phase also 1.7x faster on Chrome from the smaller write.

  `addRect` additionally loses the per-quad closure and temporary arrays that
  `addGlyph`/`addSprite`/`addCircle` shed previously.

- 3d996c9: Cut WebGL glyph/sprite/circle batching cost by 3-5x in the per-quad hot loop.

  Profiling a 5,000-danmaku scene on real hardware (2560x1600@240Hz, 4.17ms
  budget) showed the JS batching loop at 5.4ms/frame against 0.3ms for the actual
  GPU submit — an 18x imbalance, at ~24,800 glyphs/frame (222ns/glyph). Two causes,
  both fixed with no public API or behaviour change:

  - `parseColorToRGBA` promoted every cache hit to most-recently-used via
    `Map.delete` + `Map.set`. Hits no longer promote; eviction is now
    insertion-order (FIFO), which still bounds the map.
  - `addGlyph`/`addSprite`/`addCircle` allocated a `corner` closure, a nested
    quad array-of-arrays, and a triangle-order array per quad (~10 temporaries),
    then destructured twice per vertex. Corner maths is now unrolled into a shared
    allocation-free `writeQuad`, with a `rotation === 0` fast path that skips
    sin/cos.

  Measured in real browsers on a real GPU (median of 15, accumulate phase only,
  `benchmarks/glyph-batch`), at 24,800 glyphs/frame:

  | engine  | before | after  | speedup |
  | ------- | ------ | ------ | ------- |
  | Chrome  | 3.96ms | 1.09ms | 3.7x    |
  | Firefox | 6.26ms | 1.34ms | 4.7x    |

  Per glyph that is 160ns -> 44ns (Chrome) and 252ns -> 54ns (Firefox). On Firefox
  the old path could not fit a 240Hz frame at 24,800 glyphs; it now does.

  Vertex output is bit-identical to the previous implementation (verified over
  3,000 randomised cases including rotation, maxAbsDiff = 0), and a new test pins
  rotated quad geometry, which previously had no coverage.

## 1.16.1

### Patch Changes

- Updated dependencies [48bc2ee]
  - @vectojs/layout@0.3.0

## 1.16.0

### Minor Changes

- 485eb42: Accessibility tab / screen-reader order now follows the **visual reading
  order** instead of scene-graph insertion order. `enforceA11yDomOrder` sorts the
  projected a11y mirrors into rows top-to-bottom and then inline within each row,
  so two entities added in any order but drawn side by side Tab left→right. A new
  `readingDirection: 'ltr' | 'rtl'` scene option (and `Scene.readingDirection`
  setter) reverses the inline order for right-to-left UIs. Entities at the same
  position keep their insertion order as a stable tiebreak.
- e82102c: Add forced-colors (Windows High Contrast) awareness. `Scene` now exposes a
  `forcedColors` getter backed by a `(forced-colors: active)` media query and
  repaints when it toggles, so components can swap to CSS system colors — canvas
  pixels are exempt from the browser's forced-colors remapping. `Button` uses it
  to draw with `ButtonFace`/`ButtonText`/`Highlight` under High Contrast.
- ebb4bdc: Extend the WASM transform core (G1+) to emit per-node **world-space AABBs**. The transform store now carries optional local render bounds (`bx/by/bw/bh`) and world-AABB outputs (`aminx/aminy/amaxx/amaxy`); a new `compute_aabbs` kernel (plus the `computeAabbsJS` reference + `WasmTransformBackend.computeAabbs` / resident `runAabbs` + `boundsView`/`aabbView`) transforms each node's local box through its already-composed world matrix and reduces the four corners to a min/max AABB. This is what viewport culling currently recomputes per visible node each frame (a 4-corner f64 transform in `Entity.getWorldBounds`), and what G3's hit-grid build wants to read directly from the resident matrices.

  The pass is **bit-identical** to `Entity.getWorldBounds`/`computeAabbsJS` — same corner-selection, same op order, and it matches `Math.min`/`Math.max` NaN/±0 semantics exactly (Rust `js_min`/`js_max` propagate NaN, unlike `f64::min/max`), so even a pathological transform whose scale overflows to Infinity agrees between engines. Verified across flat/chain/bushy/mixed topologies up to 100k nodes.

  Real-hardware benchmark (`benchmarks/core-wasm`, resident WASM vs the JS 4-corner pass): ~2.7–4.2× on Chrome 150 (its JIT leaves the JS loop at ~56–64 ns/entity; WASM is a steady ~15 ns), and roughly at parity on Firefox 153 (~0.9–1.3×, since its JIT already compiles the JS pass to the same ~15 ns). Never a regression; the JS path remains the permanent fallback. Not yet wired into the render walk — that integration is a separate gated step.

- 7b0d7f8: Fix DOM text-selection drift on justified text. `ContentProjectionRun` gains optional `x` / `width`: when set, the Scene lays the run out as a positioned carrier (`inline-block` + relative `left`) at the exact canvas x, the same technique the code-grid path uses. `Text` now emits positioned per-word runs on justified lines, so the native selection highlight overlaps the widened canvas glyphs instead of drifting left under the browser's natural inter-word spacing (verified on real Chrome). Left-aligned text is unchanged (no positioned runs, natural flow).
- c0bed6a: Add justify alignment and soft-hyphen breaking to the MSDF text path, reaching parity with `TextEntity`.

  - `LayoutWorker` gains a `textAlign: 'left' | 'justify'` request field. `'justify'` stretches every soft-wrapped line flush to `maxWidth` — widening inter-word spaces, or distributing slack between glyphs on a space-less CJK line — while paragraph-final and newline-ended lines stay ragged (matching `LayoutEngine`).
  - `LayoutWorker` now honors soft hyphens (U+00AD) as break opportunities: when a word overflows, it breaks at the last soft hyphen that still fits and emits a visible `-` glyph, instead of moving the whole word down.
  - `MSDFTextEntity` gains `setTextAlign('left' | 'justify')` (and a `textAlign` constructor option) plus `setHyphenator(fn | null)`. The hyphenator runs on the main thread (a function can't be structure-cloned into the layout worker), inserting U+00AD into the string sent to layout; the original text is preserved for accessibility / content projection.

- 8749a9a: RTL / bidi text selection now overlaps the drawn glyphs. The engine right-aligns and visually reorders RTL lines, but the DOM content projection previously anchored every line at x=0, so the native selection box drifted off the glyphs (measured 300px+ on real Chrome). `Text` now anchors a bidi line's projection at its **visual origin** (the line's min glyph x) while keeping it a single natural-flow string in **logical** source order — so the browser's own bidi gives correct caret hit-mapping AND the selection rectangles overlap the canvas glyphs. RTL canvas text also renders glyph-by-glyph so it can actually right-align. Verified on real Chrome 150 + Firefox 153 across DPR 1/1.5, 90% zoom, and font-substitution cases. Left-aligned LTR text is unchanged.
- 9e7f5bd: Ship the prebuilt WebAssembly accelerator in the published package and add a `@vectojs/core/wasm` entry point to load it. Previously the `.wasm` was gitignored and never copied into `dist/` or published, so npm consumers had no binary to pass to `enableWasmTransforms`/`enableWasmAnimBatching`/`enableWasmHitTest` and were silently stuck on the JS path.

  ```ts
  import { coreWasmUrl } from "@vectojs/core/wasm";
  await scene.enableWasmTransforms(coreWasmUrl);
  ```

  `coreWasmUrl` is a `URL` pointing at the co-located `dist/wasm/vectojs_core.wasm` (works in native ESM and CJS, and in bundlers via the standard `new URL(..., import.meta.url)` asset pattern). The raw binary is also reachable at the `@vectojs/core/vectojs_core.wasm` subpath. The WASM remains a pure accelerator: if it can't be fetched or a bundler drops it, every `enableWasm*` call returns `false` and the scene runs the identical-output JS path — nothing here is required for the package to work.

- 711824d: Add an optional WASM particle-simulation backend (G4) for `ComputeParticleEntity`'s CPU fallback. The per-frame particle step (spring-to-origin, mouse repulsion, explosion impulse, velocity integrate + damp + cap, boundary bounce + clamp, life decay) over 10k–100k particles now has a WASM kernel (`crates/vectojs-core-rs/src/particle.rs`) that advances the whole buffer in one call, replacing the per-particle JS `updateCPU` loop on the path that runs exactly when there is no GPU. It also fuses the separate `hasPendingAnimations` full-buffer scan into the step's return flag.

  Opt-in and invisible, matching the transform/hit/anim backends: `scene.enableWasmParticles(coreWasmUrl)` (or `setParticleBackend`) installs it; `scene.particleSimBackend` reports the active path; `updateCPU` (f64) remains the permanent fallback when no backend is installed or the scene runs on WebGPU. The kernel commits to **f32** (matching the `Float32Array` buffer and the WGSL compute shader) and is a _separate_ differential oracle from the f64 transform core: it is bit-identical to a JS f32 reference (`particleStepReferenceF32`, verified over 60 steps across spring/mouse/explosion/clamped scenarios), and differs from `updateCPU`'s f64 by <1 ULP/step — the accepted CPU-vs-GPU-class divergence.

  Real-hardware benchmark (`benchmarks/particle-wasm`, Chrome 150 + Firefox 153), including the per-frame AoS↔SoA transpose in the WASM timing: **~2.1–2.5× on Chrome and ~1.4–2.0× on Firefox** across 1k–100k particles (e.g. 100k: 4.60 ms → 2.18 ms Chrome, 2.59 ms → 1.30 ms Firefox per frame). Baselines in `vectojs-docs/forge/baselines/particle-wasm-*`.

### Patch Changes

- 2ac0bae: Add ARIA live-region and validation-state support to `A11yAttributes`, projected onto each interactive entity's shadow element by `Scene.syncA11y`. Previously there was no `aria-live` anywhere, so streamed chat messages, toasts, and async validation summaries were silent to screen readers (WCAG 4.1.3). `getA11yAttributes()` can now return `live` (`'off'|'polite'|'assertive'`), `atomic`, and `relevant` for live regions, plus `labelledby`, `describedby`, `required`, `invalid`, and `level` for labelling and field-validation state (WCAG 3.3 / 1.3.1). All are dirty-checked and removed when cleared, matching the existing optional-attribute sync.
- 0cd149c: Three browser-robustness fixes:

  - **WebGPU particle canvas was blurry on HiDPI** — the `gpuCanvas` backing store was sized in logical pixels (`width`/`height`) and then CSS-stretched, so on a 2× display it rendered at half resolution. It now sizes the backing store to logical × effective DPR (clamped to `maxDPR`, matching `CanvasRenderer`) with the CSS box at the logical size, both at creation and on `resize()`.
  - **Physics jumped on tab refocus** — the render loop fed the full elapsed time into `update(dt)` and property drivers, so a backgrounded tab (rAF paused for seconds) advanced everything by that entire gap on the first frame back (springs explode, tweens snap past their end). `dt` is now clamped to a 100 ms max-frame cap, so a stall advances at most one slow frame; frame-rate telemetry still uses the true elapsed time.
  - **Embedded (`disableWindowResize`) scenes never resized** — they only listened for `window` `resize`, which never fires when it's the canvas _element_ (not the window) that changes size. Embedded scenes now attach a `ResizeObserver` to the canvas and re-run `resize()` at its new logical size, disconnected on `destroy()`.

- c07a9f7: Cache the per-frame `ComputeParticleEntity` collection. `Scene.render` walked
  the entire tree every frame to gather compute entities — even for the
  overwhelmingly common scene that has none, which paid an O(tree) walk per frame
  just to build an empty array. The list now rebuilds only on a structural change
  (add/remove/reparent, via the existing `_structureVersion`), so a
  structurally-stable frame is O(1). Real-HW (`benchmarks/per-frame-walk`, Chrome
  150 + Firefox 153): the eliminated walk grew to ~0.27ms/frame at 16k nodes on
  both engines. Behavior is unchanged (the gathered set is identical); verified by
  a structure-version cache test plus the existing particle/WebGPU suites.
- e22af44: Recover from Canvas2D context loss (`CanvasRenderer`). A GPU reset or memory-pressure `contextlost` on the 2D canvas would previously leave the scene permanently blank — the renderer kept issuing draw calls against a dead context. It now listens for `contextlost`/`contextrestored`: on loss it calls `preventDefault()` (required, or the browser never fires `contextrestored`) and marks the context lost so `clear()` and the render pass become no-ops; on restore it re-acquires the 2D context, re-applies the DPR transform, drops cached style, and fires an `onContextRestored` callback that `Scene` uses to repaint the (freshly cleared) canvas. `IRenderer` gains optional `isContextLost()` / `onContextRestored()`, and `Scene.render` skips a pass while any renderer reports its context lost. No-op where the canvas has no `addEventListener` (SSR).
- 4d9d77b: Clip interactive a11y projections by `clipChildren` ancestors and the viewport. `Scene.syncA11y` positioned each interactive entity's transparent shadow element but never gated its visibility, so a `Button` (or any interactive control) scrolled out of a `ScrollView`/`VirtualList` stayed clickable, focusable, and announced to screen readers — and could intercept clicks over whatever was drawn on top of it. The interactive branch now applies the same exact (margin 0) `projectionBoxVisible` test the content-projection branch already used, hiding the mirror with `display:none` when the entity's world box is fully outside its `clipChildren` ancestors or the viewport, and restoring it when it scrolls back in. `a11yFullViewport` overlays are intentionally exempt (they are unbounded by design).
- 4749105: Hoist the content-projection viewport gate above `getContentProjection()` in `Scene.syncContentProjection` (CTX-0024). Previously the projection was computed **unconditionally** for every block every synced frame and the viewport-virtualization gate ran afterward — since `getContentProjection()` is O(glyphs-in-block), a long or streaming document cost O(total document glyphs) per frame, the dominant driver of the streaming-into-Markdown FPS decay. The gate needs only the node/world-transform/margin, so it now runs first and off-viewport blocks cost O(1) (freed if already materialized, never projected otherwise).

  Measured on real hardware (Chrome 150 + Firefox 153, `benchmarks/content-projection`): the gated per-frame sync stays flat as the document grows while the pre-fix path grows linearly — at 1600 blocks (~384k glyphs) the sync pass drops from 23.95 ms → 0.87 ms on Chrome (27.5×) and 16.54 ms → 0.56 ms on Firefox (29.5×). On-viewport rendering and selection are unchanged.

- 4fc27c7: Stop `scene.remove()` from leaking still-animating entities. An entity spawns a property driver by registering itself in the Scene's batched-driver candidate set, which is only self-pruned when the driver _completes_. Removing an entity mid-animation (a route change on a spinner, a dismissed toast still easing out) never unregistered it, so it stayed pinned in the set — a memory leak — and its drivers kept ticking every frame even though it was off-tree. `scene.remove()` / `hideOverlay()` now unregister the whole removed subtree, and `scene.add()` / `showOverlay()` re-register any node that still has live drivers, so re-attaching a subtree that was removed mid-animation resumes its motion.
- 778f0c9: Cover the `TreeView` / `ContextMenu` per-child a11y hotspots in the real-browser
  e2e. Their `role="treeitem"` / `role="menuitem"` projection, roving tabindex, and
  `aria-haspopup` had only ever been asserted in jsdom, and — more importantly —
  so had the `pointerEvents: 'none'` contract that keeps them from stealing the
  mouse from the component underneath (tap-to-toggle, drag-to-scroll). That is the
  same class of regression CI already caught once for `Table` cells, so it now runs
  in both Chrome and Firefox against `elementFromPoint`.

  The fixture adds the menu but deliberately leaves it **closed**: showing a
  `ContextMenu` installs a full-scene interactive backdrop to catch the outside
  click, which intercepts every pointer drag and broke four unrelated selection
  assertions. The probe opens it, measures, and closes it again.

  Also fixes each benchmark `serve.ts` logging a hardcoded `http://127.0.0.1:8178`
  regardless of the `PORT` it actually bound — a mismatch that misleads debugging.

- 69f344f: Fix `Entity.destroy()` to recurse into the whole subtree instead of only tearing down the entity itself. Previously only `Scene.destroy()` walked the tree, so calling `entity.destroy()` — or `scene.remove(subtree)` on an SPA route change — stranded every descendant's GPU buffers, layout workers, and DOM observers (the root cause behind the MSDF worker, compute-particle GPU, DOM-portal observer, and streaming-Markdown leaks). `destroy()` is now the single leaf-first recursion point: it destroys descendants (deepest last-detached), then clears its own animations/drivers/listeners, then detaches from its parent. It is idempotent and re-entrancy safe via an internal guard, so subclasses that free a resource which is also a child (e.g. `ContextMenu`) no longer double-free. `Scene.destroyEntitySubtree` now delegates to `entity.destroy()`.
- a3cf4d0: `Scene.findEntityAt` (its JS hit-test walk, the permanent fallback) now respects visibility and pointer-input gating that the previous "run `isPointInside` on every node" walk ignored:

  - **Invisible subtrees**: a node (and its whole subtree) with `opacity <= 0` is no longer a hit target — it isn't drawn, so it shouldn't intercept pointer input.
  - **Clipping**: a descendant that falls outside a `clipChildren` ancestor's world box is no longer hit, even though its own `isPointInside` returns true — matching what's actually visible/clickable on screen.
  - **Disabled / non-interactive**: a node whose `getA11yAttributes()` reports `disabled: true` or `pointerEvents: 'none'` is skipped as a target (its children are still walked, so a transparent container can hold hittable descendants).

  Top-most-wins ordering is unchanged. (The WASM hit-grid path indexes geometry only; applying the same clip/opacity/disabled gating there is a tracked follow-up — the JS walk is the correctness reference.)

- 7e6f76d: Fix two interaction bugs found by verifying the suspected input/a11y list (three
  of the listed items turned out to need no change):

  - **Hover was never cleared when an entity was removed mid-hover**
    (`@vectojs/core`). Hover is driven by the projected shadow element's
    `mouseenter`/`mouseleave`; detaching that element fires no `mouseleave`, so an
    entity removed while the pointer was over it kept `hovered = true` forever —
    visible the moment it is re-added (a pooled virtualized row, a reopened menu) as
    hover styling with no pointer anywhere near it. Removal now synthesizes the
    `pointerleave`, including for hovered descendants of a removed subtree, and
    emits nothing when the entity wasn't hovered or had already left.
  - **IME composition over a selection painted a stale highlight**
    (`@vectojs/ui`). Composing over selected text logically replaces that range, but
    the native `<input>`/`<textarea>` keeps reporting the pre-composition
    `selectionStart`/`selectionEnd` until commit — so `Input` and `TextArea` drew the
    old selection behind (and wider than) the composition underline. The selection
    highlight is now suppressed while a non-empty composition is active.
  - **`TextArea` never drew a composition underline at all** (`@vectojs/ui`). It
    tracked `composition` but never used it, leaving a multi-keystroke IME
    conversion with no in-canvas feedback. It now underlines the composing range,
    per line so a wrapped composition is marked on every line it covers.

- b377c32: Four interaction / accessibility fixes:

  - **`Button` focus ring never appeared** — `render()` drew a ring when `focused`, but nothing set it. Button now syncs `focused` from the `focus`/`blur` events the Scene emits on its shadow `<button>`, so keyboard users get a visible focus indicator.
  - **`Link` opened two tabs** — the shadow `<a href target="_blank">` navigates natively on a real DOM click, and that click was also forwarded to the entity's handler which called `window.open` again. Link now skips `window.open` when the click is a genuine DOM click on an `<a>` (native navigation already happened), while still opening for canvas/Three/XR-path clicks where no anchor navigated.
  - **`Modal` had no dialog semantics** — it now reports `role="dialog"` + `aria-modal="true"` (new `A11yAttributes.ariaModal`, synced by `Scene`), closes on `Escape`, moves focus into the dialog on open, and restores focus to the previously-focused element on close.
  - **`Overlay.hide()` left it interactive and announced** — setting `opacity = 0` alone kept the overlay hit-testable, focusable, and read by screen readers. `hide()` now also clears `interactive` and prunes the a11y/portal shadow subtree (`detachA11y`); a later `showAt`/`showAtPoint` re-shows it and the per-frame sync re-creates the shadow nodes.

- 97e97bb: Complete the lifecycle-leak teardown on the `destroy()` path (follow-up to the `Entity.destroy()` recursion fix):

  - **MSDF worker slot**: `MSDFTextEntity.destroy()` now cancels its queued layout via a new static `LayoutWorkerManager.cancelLayoutForEntity(id)` that no-ops when no manager exists, instead of `getInstance().cancelLayout()` which resurrected the worker singleton (and threw in SSR, where `Worker` is undefined) purely to cancel.
  - **DOMPortalEntity observer/listeners on `scene.remove()`**: the `ResizeObserver` and DOM event listeners are now managed by `attachDOMBindings()` / `releaseDOMBindings()`. `scene.remove()` (and off-screen portal reconcile) releases them so a detached portal no longer leaks an observer that keeps its element alive and firing; the projection path re-attaches them idempotently if the portal is re-added, so remove→re-add still works.
  - **Streaming Markdown**: `setContent()` and `updateTokens()` now `destroy()` discarded blocks (freeing each block's subtree resources) instead of only detaching them, and a new `Markdown.destroy()` drops this instance's in-flight worker callbacks (each pinned the whole entity via its closure) before recursing the content subtree.
  - **ComputeParticleEntity**: no code change needed — the `Entity.destroy()` recursion already frees nested particle GPU buffers; added a regression test proving a nested particle subtree's buffers are all released.

- cca3235: Two measured per-frame wins from the micro-walk survey (the rest of that list was
  measured and found not to be hotspots — see below):

  - **`measureText` shaped before checking its own cache** (`@vectojs/ui`). The LRU
    was keyed on the _shaped_ text, so every cache **hit** still ran
    `ArabicShaper.shapeArabic()` first — measured at ~60% of the whole hit cost
    (49.7ms of 83ms per 20k hits), and pure overhead for the ASCII majority where
    shaping returns the input unchanged yet still allocates an index map. The key is
    now the raw text and shaping happens only on a miss: **4.14µs → 0.34µs per hit
    (12×)**. Arabic is still measured in its contextually-shaped form — the change
    affects only _when_ shaping runs.
  - **`syncOverlayGeometry` re-wrote every overlay style every frame**
    (`@vectojs/core`). It assigned ten style properties per overlay layer on every
    synced frame even when the canvas box, logical size, and CSS↔logical scale were
    all unchanged — the normal case, since those only move on resize, zoom, or an
    ancestor scroll. It now memoizes the geometry it last wrote and returns early
    when nothing moved; the memo is invalidated when a WebGL/WebGPU layer is created
    lazily, so a brand-new layer is still positioned.

  Measured and **not** changed, to save the next person the investigation: the
  `scene` getter's parent-chain walk (`Entity.ts`) costs 0.14µs per read at depth 50
  (28.4ms per 200k reads) — caching it would add reparenting/attach invalidation
  complexity for no measurable gain.

- de71fed: Pause the render loop when the canvas scrolls fully off-screen. A running `Scene` requested a `requestAnimationFrame` every frame regardless of whether its canvas was visible, so a dashboard tab, a chart below the fold, or any scrolled-away scene kept paying the full per-frame update/render cost for something nobody could see. `Scene` now observes its canvas with an `IntersectionObserver`: while the canvas is off-screen the loop does no work and stops rescheduling, and the observer resumes it (resetting the frame clock) when the canvas re-enters the viewport. `markDirty()` calls made while hidden are preserved and consumed on the resume frame. No-op where `IntersectionObserver` is unavailable (SSR/tests), so that behavior is unchanged; the observer is disconnected on `stop()`/`destroy()`.
- bed7b65: Fix `scene.mouseX`/`mouseY` (and pointer-driven particle repulsion) freezing
  when the cursor is over projected text or an interactive a11y mirror. Those
  overlay elements sit above the canvas with `pointer-events: auto`, so a
  `pointermove` over them fired on the element and never reached the
  canvas-bound listener. The pointer listeners are now attached to the canvas's
  parent container, so moves over any layer keep the tracked position current;
  `pointerleave` still resets only when the pointer exits the whole region.
- 9c46a4b: Preserve focus when a focused a11y projection is virtualized, streamed away, or otherwise removed. Removing the DOM element that holds `document.activeElement` drops focus to `<body>`, which yanks a screen reader out of the scene's a11y region back to the top of the page — the classic "lost my place on scroll/stream" bug for `VirtualList`-recycled or streamed controls. `Scene` now keeps a persistent `tabindex=-1` focus sentinel inside `a11yRoot` (kept last in DOM order); when the focused mirror is pruned at any of the three removal sites (`removeA11yRecursively`, the runtime tag-change path, and the `enforceA11yDomOrder` prune) while it is the active element, focus moves to the sentinel first, so it stays within the app region instead of collapsing to the document body.
- f334b02: Preserve a text selection across a streaming content-projection rebuild. `Scene.syncContentProjection` replaces a content element's DOM (`replaceChildren`) whenever its projection signature changes — every appended chunk while a message streams — which previously wiped any selection the user had made, even in the unchanged prefix ("can't select text in a message still receiving tokens"). The rebuild now snapshots the selection's anchor/focus as linear character offsets within the element (via `projectionAbsoluteOffset`) and re-resolves them against the new DOM afterward (`projectionCaretAt`), so a selection in text that survives the rebuild is restored in place. It only fires when the element owns the selection and no drag is active, and it clears (rather than mis-restores) when the selected range ran into text that the update removed. The virtualization case — where the element itself is freed — remains out of scope (the browser genuinely drops the selection with the node).
- 0416c56: Raise the default `Scene.animDriverGateCount` from 128 to 256, based on a re-run of the integrated `benchmarks/anim-wasm-scene` sweep on real Chrome 150 and Firefox 153 (0 correctness mismatches across spring/tween/mixed). The previous 128 default was validated only in aggregate; broken out by driver kind, pure-tween scenes are a net LOSS at n=128 on Chrome (0.71×, ~40% slower than the JS tick path) and only turn net-positive around n≈256, while spring/mixed win from n=128 up. 256 keeps the gate net-positive across all three driver kinds rather than opening early on a tween-heavy scene and making it slower. This only affects apps that opt into WASM animation batching via `enableWasmAnimBatching`; the JS tick path (default) is unchanged, and the gate remains a public field you can tune for your own browser/driver mix.
- e4969a9: Re-render on a runtime `devicePixelRatio` change. The DPR was applied only inside `renderer.resize()`, which fires on a `window` resize — but dragging the window to a monitor with a different pixel density, or a browser zoom that changes DPR without changing the logical size, left the canvas backing store rasterized at the old DPR and visibly blurry. `Scene` now arms a `(resolution: Ndppx)` media query for the current DPR and, on change, re-runs `resize(width, height)` (re-scaling the backing store) and re-arms a fresh query for the new ratio (a resolution query only fires when leaving its exact value). It runs even for embedded (`disableWindowResize`) scenes, since they blur the same way, and is torn down on `destroy()`. No-op where `matchMedia` is unavailable.
- 29e9cbd: Bring `findEntityAt`'s WASM hit-grid path to parity with the JS walk's clip/opacity/disabled gating (follow-up to the JS-path fix). The WASM path confirmed a grid candidate with `isPointInside` only, so it could still return an invisible (`opacity: 0`) node, a descendant clipped outside a `clipChildren` ancestor, or a `disabled`/`pointerEvents: 'none'` element — diverging from `findHitRecursively`. A shared `isHitEligible(entity, x, y)` gate (walks ancestors for opacity and `clipChildren` containment, plus the pointer-transparency check) now guards both the candidate scan and the boundless-entity pass, so the WASM and JS hit paths return the same entity for every query.
- 8a0a9c8: Recover the WebGL point layer from a GPU context loss (driver TDR reset, tab backgrounded on mobile, GPU switch). `WebGLPointRenderer` never handled `webglcontextlost`/`webglcontextrestored`, so after a context loss the layer stayed permanently blank — and, critically, without calling `preventDefault()` on the `lost` event the browser never fires `restored` at all. `Scene` now attaches recovery listeners to its WebGL canvas: on `webglcontextlost` it calls `preventDefault()` and drops the (now-dead) renderer so the render loop skips the layer; on `webglcontextrestored` it rebuilds the renderer from scratch via the registered creator, restores DPR/size, and repaints. Listeners are removed on `destroy()`, and a `restored` event that arrives after teardown is inert. (The `@vectojs/three` renderer, which has its own Three.js restore machinery, is a separate follow-up.)
- Updated dependencies [2bebe0c]
- Updated dependencies [c5c720a]
- Updated dependencies [7b7b2b6]
- Updated dependencies [04a1c6f]
- Updated dependencies [778f0c9]
- Updated dependencies [26b9bdf]
- Updated dependencies [97e97bb]
- Updated dependencies [c0bed6a]
- Updated dependencies [eaf9ecc]
- Updated dependencies [539700d]
- Updated dependencies [63fc4b7]
- Updated dependencies [5eae419]
  - @vectojs/text@0.2.0
  - @vectojs/layout@0.2.0
  - @vectojs/animation@0.1.1
  - @vectojs/math@0.1.1

## 1.15.0

### Minor Changes

- 3a623c1: Decouple the standalone engines out of `@vectojs/core` into their own packages:
  `@vectojs/layout`, `@vectojs/text`, `@vectojs/math`, and `@vectojs/animation`.
  `@vectojs/core` now depends on and re-exports them, so its barrel and its
  `./layout`, `./text`, and `./renderer` subpaths are unchanged — existing imports
  keep working with no source changes. This is an internal restructuring for
  long-term maintainability; there are no breaking API changes.

### Patch Changes

- Updated dependencies [3a623c1]
- Updated dependencies [3a623c1]
- Updated dependencies [3a623c1]
- Updated dependencies [3a623c1]
  - @vectojs/animation@0.1.0
  - @vectojs/text@0.1.0
  - @vectojs/math@0.1.0
  - @vectojs/layout@0.1.0

## 1.14.0

### Minor Changes

- 68a26d0: Virtualize content projection: only materialize near-viewport text as DOM.

  `Scene.syncContentProjection` previously created a transparent, position-synced
  DOM node (plus a `<span>` per visual line) for **every** text entity in the
  scene, regardless of viewport — a document taller than the screen materialized
  one element per block for the whole document (measured ~14.8k DOM elements /
  9.4k text nodes for a 346KB Markdown reader). Off-viewport nodes were merely
  `display:none`-hidden, so they still cost heap and forced the browser to reflow
  all of them whenever the view scrolled — the cause of choppy large-document
  scrolling, a ballooning heap, and (once the a11y sync was throttled to cope)
  text-selection lagging the rendered glyphs.

  The projection is now viewport-virtualized like canvas rendering already is:
  only entities whose world box is within a margin of the viewport (and of every
  `clipChildren` ancestor) are materialized; nodes are freed when they scroll past
  the margin and re-created when they return. This bounds the projected DOM to the
  visible working set, so heap stays flat and per-frame content sync stays cheap
  enough to run every frame (keeping selection glued to the glyphs).

  New `SceneOptions.contentProjectionMargin` (CSS px, each side; default one
  viewport height) tunes how much off-screen text stays ready for native
  find-in-page / selection; `Infinity` restores the previous
  materialize-everything behavior.

## 1.13.0

### Minor Changes

- 90a9f00: Add `Scene.frameStats`: live render-loop telemetry for profilers and devtools overlays. Exposes `fps` (derived from the interval between actually-rendered frames, so idle `onDemand` scenes and frames dropped by the `maxFPS` cap or static auto-throttle don't deflate it, and clamped to `maxFPS`), `frameTimeMs` (wall-clock cost of the last `render()` pass), `frameIntervalMs`, `dt`, `renderedFrames`/`skippedFrames` counters, `renderMode`, and the `dirty` redraw-pending flag. Timings are measured on the `requestAnimationFrame` loop; a scene driven only by `step()` (deterministic export) leaves them zeroed. The renderer always repaints the full canvas, so no partial dirty-rectangle is reported. New `FrameStats` type exported.

## 1.12.0

### Minor Changes

- Add `TextRasterCache`: an isolated, DPR-aware cache of pre-rasterized text runs.
  Views that draw the same short strings thousands of times per frame
  (danmaku/barrage, chat/log tails, data-grid cells, particle labels) can
  rasterize each distinct `(font, color, text)` run once and blit it with
  `drawImage` instead of paying the per-call `fillText` shaping + color-parse cost
  every draw. Bounded by an insertion-order eviction cap; falls back to `null` in
  headless/non-DOM contexts so callers keep a `fillText` path.

## 1.11.3

### Patch Changes

- 04ac275: Fixed `ComputeParticleEntity`-based scenes silently dropping to Scene's `renderMode: 'always'` idle auto-throttle (~2fps) whenever nothing else in the tree was animating — despite particles visibly drifting, bouncing, or spring-settling. `ComputeParticleEntity` never overrode `hasPendingAnimations()` (the base `Entity` default is always `false`), so Scene's idle detection had no way to know the particle simulation — which runs through a dedicated pre-pass outside the normal per-entity update walk — was still doing visible work. Any app relying on the particle system's own `markDirty()` calls (fired only from discrete API calls like `setOrigins`/`triggerExplosion`, not per simulation tick) had no ongoing signal once those settled.

  `hasPendingAnimations()` now scans live (`life !== 0`) particles for a velocity or origin-offset above a small epsilon (0.5px/s, 0.5px) — large enough that an asymptotically-converging spring+damping system correctly reports "at rest" once it's visually indistinguishable from settled, small enough that genuine motion is never missed. A pending `triggerExplosion()` also counts as pending, since its impulse hasn't been applied to any particle yet at the moment it's requested.

## 1.11.2

### Patch Changes

- 229d07d: Fixed visible animation stutter on high-refresh-rate displays (e.g. 240Hz) when `Scene.maxFPS` is set below the display's native rate. `Scene.loop()`'s frame-rate cap is a hard skip/render gate: it accepts the first rAF tick whose elapsed time crosses `1000/maxFPS - 1`, then uses the raw elapsed wall-clock time as `dt`. On a display where the render loop's own scheduling margin doesn't evenly divide the display's refresh interval (any real display has sub-millisecond compositor/OS jitter, and 240Hz simply offers more candidate tick boundaries per target frame than 60Hz), that raw `dt` bounces around the nominal interval frame-to-frame — e.g. alternating between ~13ms and ~20ms around a 16.667ms target for `maxFPS: 60` — even though the _average_ dt still converges on the correct value (so FPS counters built by averaging, including the `requestAnimationFrame`-sampling pattern several Motif demos use for their live HUD, read a correct 60fps while the actual motion visibly stutters). Physics and animation code that integrates `update(dt)` directly receives this jitter unmodified.

  `dt` is now snapped to the nominal `1000/maxFPS` interval whenever it's already within 30% of that value — this absorbs ordinary scheduling noise without hiding genuine slowness: a real stall (backgrounded tab, GC pause, a frame that took multiple target-intervals to arrive) is far outside that band and passes through unchanged, so no "catch-up" backlog accumulates and no slowness is masked. Uncapped scenes (`maxFPS: 0`) are unaffected — quantization only applies when a cap is in effect.

## 1.11.1

### Patch Changes

- ec27242: Assign semantic DOM stacking order in the same frame that newly interactive overlay entities are projected.

## 1.11.0

### Minor Changes

- 87302ce: Added `Entity.focus()` — programmatic focus for an entity's projected a11y shadow element, with one rAF retry if the element hasn't been created by the next sync yet (closing the "projected element exists only after next a11y sync" gap, findings.md 2026-07-10).

  Added `'dblclick'` to the `VectoEvent` union and wired a native `dblclick` listener on each entity's shadow element in `Scene.syncA11y` — same dispatch pattern as `click` (findings.md 2026-07-10: "no dblclick event in core event routing"). The existing `a11yRoot`-level `dblclick` handler for text word-selection fires on the content-projection DOM layer and is unaffected by this change.

  Note: `A11yAttributes.tabIndex?: number` (Entity.ts line 183) and `Scene.syncA11y`'s `attrs.tabIndex` read (Scene.ts line 1526) were already shipped in a prior release — the corresponding findings.md entry 2026-07-10 ("keydown unreachable for entities outside INTERACTIVE_ROLES") was already resolved in code but not yet marked in the log; updated in this same pass.

## 1.10.0

### Minor Changes

- c11d386: Added `SceneOptions.maxDPR` to cap the effective device pixel ratio used to size the Canvas2D and WebGL point-layer backing stores. Backing-store render cost scales with `logical size × dpr²`, so a full-screen HiDPI scene (`pointBackend: 'webgl'` in particular) can overrun its frame budget on a DPR-3 display while running fine on the DPR-1 dev machine it was tuned on — a real jank case measured at 116ms max-frame on a HiDPI display versus flawless 60fps at DPR 1 (findings.md, 2026-07-16). Apps previously had no choice but to monkey-patch `window.devicePixelRatio` before creating the Scene as a workaround (each demo owning its own document made this safe, but it shouldn't have been necessary). `maxDPR` is `undefined` by default (uncapped, real DPR — unchanged behavior from prior versions), and is re-applied on every `Scene.resize()` call (including the automatic window-resize listener), not just at construction, since the real DPR can change at runtime.

  `CanvasRenderer` and the WebGL `PointRenderer` interface both gained a public, settable `maxDPR` field (used internally by `Scene`; also usable directly by anyone constructing a `CanvasRenderer` outside a `Scene`). No change to the WebGPU particle canvas path, which already sizes 1:1 to logical width/height with no DPR multiply.

## 1.9.2

### Patch Changes

- 9711fdf: Match `DOMPortalEntity.add()` to the variadic `Entity.add()` signature so
  multi-child calls hit the same leaf-node warning instead of a narrower
  override.

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
