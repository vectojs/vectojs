---
'@vectojs/three': patch
'@vectojs/video-exporter': patch
---

**@vectojs/three**

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
