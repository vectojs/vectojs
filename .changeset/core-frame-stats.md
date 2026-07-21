---
'@vectojs/core': minor
---

Add `Scene.frameStats`: live render-loop telemetry for profilers and devtools overlays. Exposes `fps` (derived from the interval between actually-rendered frames, so idle `onDemand` scenes and frames dropped by the `maxFPS` cap or static auto-throttle don't deflate it, and clamped to `maxFPS`), `frameTimeMs` (wall-clock cost of the last `render()` pass), `frameIntervalMs`, `dt`, `renderedFrames`/`skippedFrames` counters, `renderMode`, and the `dirty` redraw-pending flag. Timings are measured on the `requestAnimationFrame` loop; a scene driven only by `step()` (deterministic export) leaves them zeroed. The renderer always repaints the full canvas, so no partial dirty-rectangle is reported. New `FrameStats` type exported.
