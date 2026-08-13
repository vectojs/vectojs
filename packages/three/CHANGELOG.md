# @vectojs/three

## 0.1.9

### Patch Changes

- 3283905: Fix the 2026-08-13 full-repo review's lower-severity findings (P3):

  - `@vectojs/graph3d`: `Graph3D.setGraphData` now resolves link endpoints before clearing or attaching anything, so a link naming an unknown id throws while the previous graph stays fully intact (it used to leave a half-built graph in the scene). `GraphInteraction.dispose()` during an active drag now runs the finish path, re-enabling host controls and firing `onDragEnd` (they previously stayed disabled forever). `VectoForceLayout`: exactly-coincident unlinked nodes now separate — the octree stores coincident points as distinct deterministic-jittered leaves, the repulsion skip identifies the query point's own leaf by identity instead of `d2 === 0` (which also skipped coincident _other_ points), and the flat octree arrays grow past the 8n+8 bound instead of silently dropping typed-array writes into NaN forces; the class docstring now correctly states that the octree accumulates in f64 while positions/velocities stay f32.
  - `@vectojs/three`: `ThreeAdapter` no longer dispatches a duplicate/spurious `pointerleave` to the entity under the last hover position when the pointer exits the mesh. `ThreeRenderer.fillText` rasterizes at the renderer pixel ratio and keys its texture cache on DPR, so HiDPI displays stop rendering blurry glyphs. `fillCircle`, solid path fills, gradient fills and `drawImage` materials are now `DoubleSide`, fixing the mirrored y-down ortho projection culling their FrontSide geometry (the fillText fix from #511 applied to every remaining mesh path).
  - `@vectojs/video-exporter`: `normalizeOptions` rejects odd width/height up front — H.264 yuv420p cannot encode them and previously only failed with raw ffmpeg stderr at the very end of the export.
  - `@vectojs/styles`: the `fontSize` style type is narrowed to a unit-bearing `${number}px` string, matching the runtime rejection of bare numbers (numeric `var()` tokens still throw the targeted error). `var()` tokens that reference other tokens now resolve transitively with cycle detection, instead of leaking the literal `var(--…)` into string fields that Canvas2D silently ignored.

- ae13ded: Make `setTheme` atomic on token-resolution failure: every tracked style is now resolved against the next theme before the active theme changes, so a theme missing a referenced token throws while the scene, theme and pair bookkeeping stay fully under the previous theme (previously entities were left half-restyled and pairs half-migrated). And fix `ThreeRenderer.fillText` placement: parse the size out of the weight-first font shorthand (`'700 16px Inter'` produced a 1050px texture before), keep the raster texture unflipped so glyphs stay upright under the y-down ortho camera, draw the plane double-sided so it survives the mirrored projection's culling, and position the mesh so the alphabetic baseline lands exactly at the Canvas2D `y`.

## 0.1.8

### Patch Changes

- dcb8a75: Add a GPU inspector with per-backend render counters.

  `IRenderer` gains a `kind` discriminator and optional `setDrawCounters` /
  `getDrawCounters` / `clearDrawCounters`. `kind` exists because `constructor.name`
  minifies away, and a debug tool that cannot name the backend in a production build
  is not much use. `CanvasRenderer` implements the counters: fills, strokes, text,
  images, circles, batch commits, save/restore, clips, and style switches that were
  not elided. Off by default, so the guard is one null test per op.

  `WebGLPointRenderer` exposes `stats()`: per-frame and cumulative draw calls, MSDF
  atlas switches, and the split between circles on the `gl.POINTS` fast path and
  those falling back to quads. Batching there is per primitive type, so draw calls
  and batches are the same number. `Scene` gains `webglDrawStats` and
  `webgpuActive`; both GPU backends were entirely private before, so no reading was
  possible at all.

  `inspectGpu(scene)` aggregates all three sources plus existing phase timings and
  frame telemetry, and `auditGpu` reports `batch-not-amortising`,
  `unbalanced-save-restore`, `high-overdraw` and `circle-quad-fallback`.

  Three capabilities are named as unavailable rather than approximated. GPU timestamp
  queries need a `requiredFeatures` device request, query sets, resolve and staging
  buffers, and out-of-band async readback that cannot share the synchronous phase
  shape. Exact overdraw needs pixel-coverage readback Canvas2D does not offer, so
  `overdrawRatio` is submitted-area over surface-area, labelled a proxy that
  overstates, and its audit finding is `info` rather than `warn` for that reason.
  Deep WebGL frame capture points at Spector.js rather than vendoring it.

  Inactive and idle are reported differently throughout: `null` means the backend is
  not running, zero means it ran and did nothing.

## 0.1.7

### Patch Changes

- cd92499: `ThreeRenderer` now recovers from WebGL **context loss** and tracks **runtime
  DPR** changes, matching the Canvas2D / WebGL point-layer paths in
  `@vectojs/core`. A GPU reset previously left a Three-backed scene permanently
  blank, and a monitor move / browser zoom left it rendering at the stale pixel
  ratio (blurry or aliased):

  - `webglcontextlost` is `preventDefault`-ed (required for the browser to fire
    `webglcontextrestored`) and flips an `isContextLost()` flag; `present()`
    becomes a no-op while lost.
  - `webglcontextrestored` re-applies pixel ratio + size (a restore can land on a
    different display) and forces a repaint of the freshly-cleared framebuffer.
  - A `resolution` media query re-applies `setPixelRatio` on DPR change and
    re-arms itself (one-shot query), guarded for SSR / OffscreenCanvas.
  - Both sets of listeners are detached in `dispose()` so a torn-down renderer
    can't be resurrected by a late event.

- b4ebfa0: Bound `ThreeRenderer`'s image-texture cache. `drawImage` cached one `THREE.Texture` per source keyed by identity, but the cache had no size limit — a long-running scene that draws many distinct images (or transient per-frame canvases that are never `invalidateImage`'d) accumulated GPU textures without bound. The cache now caps at 256 entries (mirroring the existing text-texture cache): a cache hit re-inserts the source as most-recently-used, and once the cap is exceeded the least-recently-used texture is disposed and evicted.

## 0.1.6

### Patch Changes

- Tighten the `@vectojs/core`/`@vectojs/ui` peer dependency ranges to `>=1.0.0 <2.0.0` now that both have reached 1.0.0. The previous unbounded `>=0.1.0`/`>=0.2.7` ranges would have silently accepted a future breaking `2.0.0` of either package with no peer-dependency warning, defeating the point of the semver commitment.

## 0.1.5

### Patch Changes

- 8da5d8c: Engine cleanups: WebGL circles that gl.POINTS cannot represent (center near/off the viewport edge, or diameter beyond the GPU point-size cap) now render through a triangle-quad fallback instead of popping or shrinking; the Scene loop no longer re-walks the tree up to 4x per tick (animation/interactive flags are collected during the render walk); legacy animate() wakes idle onDemand scenes; ThreeRenderer caches drawImage textures per source with an invalidateImage() API.

## 0.1.4

### Patch Changes

- f4c98f3: clip() scissors by the renderer's own pixel ratio instead of window.devicePixelRatio; fillText reuses rasterized textures through an LRU cache instead of re-uploading per call per frame.
- e45ec38: - `ThreeRenderer.flush()` no longer performs a full GL render per call — the Scene flushes around every non-batched node, which made frames O(N²) in entity count. Rendering now happens once per frame in the new `present()` hook (with a microtask fallback for older cores that never call it).
  - `stroke()` emits one `THREE.Line` per sub-path instead of concatenating all of them into a single line — no more spurious connector segments across `moveTo()` gaps.

`@vectojs/three` is excluded from the automated Changesets flow
(`.changeset/config.json`'s `ignore` list) and is versioned by hand: bump
`packages/three/package.json`, commit, tag `@vectojs/three@<version>`, and push the tag —
the [publish workflow](../../.github/workflows/release.yml) takes it from there.

## 0.1.3 (2026-07-05)

### Fixed

- Preserve pointer and wheel modifier keys when routing Three.js raycast events into VectoJS.
- Reset renderer transform, alpha, and clip stacks between frames; intersect nested clips and use
  non-negative transformed scissor bounds.
- Honor alpha channels in CSS colors for solid fills, strokes, and circles.
- Dispose objects, materials, textures, renderers, and adapter-owned canvases exactly once while
  preserving caller-owned canvases.

## 0.1.2 (2026-07-03)

### Fixed

- **UV hits now map to logical scene coordinates, fixing mis-clicks on HiDPI displays.**
  `@vectojs/core`'s `CanvasRenderer` scales the canvas backing store by
  `devicePixelRatio` (`canvas.width = logicalWidth × dpr`) while entity layout and
  `findEntityAt` stay in logical coordinates — but `dispatchAtUv` mapped raycast UVs via
  the physical `canvas.width`/`height`. On any display or browser-zoom level where
  DPR ≠ 1, every pointer event landed down/right of the cursor by exactly the DPR factor
  (at DPR 2, clicking one control activated the control roughly one panel-row lower —
  e.g. a `−` stepper click toggling a switch two rows below it). Now maps through
  `vectoScene.width`/`height` (logical). Invisible at DPR 1, where physical and logical
  sizes coincide — which is why unit tests and DPR-1 browser testing never caught it.

## 0.1.1 (2026-07-02)

### Fixed

- **No longer dispatch to detached a11y elements.** `ThreeAdapter`'s canvas is always
  offscreen (rendered into a texture, never inserted into the page), so its a11y shadow
  root is created but never attached to `document`. `getA11yElement()` could still return
  a real-but-permanently-disconnected element, and `dispatchEventToTarget` dispatched to it
  anyway — silently dropping `onClick`/`onChange` with no visible error (native DOM APIs
  like `setPointerCapture` could also throw from a disconnected element). It now checks
  `a11yEl.isConnected` and falls back to the same direct entity-dispatch path already used
  when no a11y element exists at all. See
  [`/reference/three.md`](https://vectojs.dev/reference/three/) on the docs site for the
  full explanation and its practical consequence.

## 0.1.0 (2026-07-01)

Renamed from `@vecto-ui/three` to `@vectojs/three` and reset the version to `0.1.0`,
matching the same-day rescope of `core` and `ui`. This is a clean version reset, not a
feature release — see those packages' changelogs for details on the rebrand itself.

The adapter's pre-rebrand development (`CanvasTexture` render interception, 3D-to-2D
raycast event translation, multi-pointer WebXR tracking, resource disposal) happened under
the old `@vecto-ui/three` name but was never separately npm-published — see the root
[`CHANGELOG.md`](../../CHANGELOG.md)'s archived history for that work.
