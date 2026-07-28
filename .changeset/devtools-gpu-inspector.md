---
'@vectojs/devtools': minor
'@vectojs/core': minor
'@vectojs/three': patch
---

Add a GPU inspector with per-backend render counters.

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
