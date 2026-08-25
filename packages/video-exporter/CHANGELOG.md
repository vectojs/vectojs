# @vectojs/video-exporter

## 0.2.4

### Patch Changes

- 0dc43e8: **@vectojs/three**

  - fix: strokes render at the requested width — `LineBasicMaterial.linewidth` is ignored by WebGL, so paths are now expanded into triangle-strip ribbons (beveled joints, flat caps); gradient strokes sample the same shader fills use instead of collapsing to the first stop color (#604)
  - fix: implement the `IRenderer.pixelRatio` contract with `maxDPR` clamping, so clamped-DPR rasterizers no longer blur against a window-ratio backing store (#604)
  - fix: `dispose()` now calls `renderer.forceContextLoss()`, stopping GL context accumulation across SPA mount/unmount cycles (#604)
  - fix: `ThreeAdapter.activePointers` prunes touch contacts on `pointerup`/`pointercancel` instead of growing monotonically until dispose; `updateIntersection` now also accepts `'pointercancel'` (#604)
  - fix: `fillText` rasterizes gradients as real Canvas2D linear gradients (axis translated into raster space) instead of collapsing to the first stop color; gradient definitions are part of the texture cache key (#604)
  - docs: gradients with more than eight stops are resampled to evenly spaced samples by the fixed 8-entry uniform table — now warned once per process as an explicit limitation (#604)
  - chore: type the SSR fallback canvas shape explicitly (`OffscreenCanvasFallback`) instead of a bare cast (#604)

  **@vectojs/video-exporter**

  - fix: attach a persistent FFmpeg stdin `'error'` handler routed through the supervisor's error path — an async EPIPE after a resolved write no longer escapes as an uncaught exception that bypasses ExportSession cleanup and orphans Chromium/Vite (#605)
  - fix: `finish()` without an AbortSignal escalates SIGTERM→SIGKILL instead of hanging forever on a wedged FFmpeg (#605)
  - fix: CLI rejects extra positional arguments loudly instead of silently exporting only the first (#605)
  - fix: stale hidden `.vecto-*` staging/backup files stranded by a killed run are reclaimed on the next export start (#605)

- 633aa7c: chore(video-exporter): deduplicate the abortError helper (#661)

  The `abortError` helper was maintained byte-identical in both
  `export-session.ts` and `ffmpeg-supervisor.ts`; hoisted to
  `src/abort-error.ts` and imported by both. No behavior change — identical
  messages, `AbortError` name and `cause` wiring on every cancellation path.

- 61b53c1: fix(video-exporter): frame 0 no longer depends on page-load timing (#646)

  The export sequence loaded the page (`networkidle0`), sized the canvas and
  stopped the scene — but between load and `stop()` the page's own rAF loop
  free-runs, so wall-clock-driven state (intro tweens, eased entrances) was
  arbitrary by capture time; every later frame was deterministic only from that
  nondeterministic base. After stopping, the exporter now calls an optional
  `window.vectoScene.reset()` once, before the fixed-step loop begins: scenes
  that render static until their first `step(dt)` are unaffected, scenes that
  carry load-time state return to their t=0 presentation. The README scene
  contract documents the requirement loudly.

## 0.2.3

### Patch Changes

- 3283905: Fix the 2026-08-13 full-repo review's lower-severity findings (P3):

  - `@vectojs/graph3d`: `Graph3D.setGraphData` now resolves link endpoints before clearing or attaching anything, so a link naming an unknown id throws while the previous graph stays fully intact (it used to leave a half-built graph in the scene). `GraphInteraction.dispose()` during an active drag now runs the finish path, re-enabling host controls and firing `onDragEnd` (they previously stayed disabled forever). `VectoForceLayout`: exactly-coincident unlinked nodes now separate — the octree stores coincident points as distinct deterministic-jittered leaves, the repulsion skip identifies the query point's own leaf by identity instead of `d2 === 0` (which also skipped coincident _other_ points), and the flat octree arrays grow past the 8n+8 bound instead of silently dropping typed-array writes into NaN forces; the class docstring now correctly states that the octree accumulates in f64 while positions/velocities stay f32.
  - `@vectojs/three`: `ThreeAdapter` no longer dispatches a duplicate/spurious `pointerleave` to the entity under the last hover position when the pointer exits the mesh. `ThreeRenderer.fillText` rasterizes at the renderer pixel ratio and keys its texture cache on DPR, so HiDPI displays stop rendering blurry glyphs. `fillCircle`, solid path fills, gradient fills and `drawImage` materials are now `DoubleSide`, fixing the mirrored y-down ortho projection culling their FrontSide geometry (the fillText fix from #511 applied to every remaining mesh path).
  - `@vectojs/video-exporter`: `normalizeOptions` rejects odd width/height up front — H.264 yuv420p cannot encode them and previously only failed with raw ffmpeg stderr at the very end of the export.
  - `@vectojs/styles`: the `fontSize` style type is narrowed to a unit-bearing `${number}px` string, matching the runtime rejection of bare numbers (numeric `var()` tokens still throw the targeted error). `var()` tokens that reference other tokens now resolve transitively with cycle detection, instead of leaking the literal `var(--…)` into string fields that Canvas2D silently ignored.

## 0.2.2

### Patch Changes

- Keep the existing API and CLI while making exports reliable: validate options, serve local entries
  without source-tree files, resolve Chromium portably, write output atomically, supervise FFmpeg
  backpressure and termination, and clean up all resources on errors, aborts, SIGINT, and SIGTERM.

## 0.2.1

### Patch Changes

- Remove the unused `@vectojs/core` runtime dependency from the video exporter package manifest.
- Clean the build output, exclude test artifacts from the published package, and emit the declared
  TypeScript definitions.

## 0.2.0

### Minor Changes

- Add `@vectojs/video-exporter` for rendering scenes to MP4 videos. Expose `Scene.step(dt)` in `@vectojs/core` for deterministic clock control.

### Patch Changes

- Updated dependencies
  - @vectojs/core@0.2.2
