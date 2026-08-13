# @vectojs/video-exporter

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
