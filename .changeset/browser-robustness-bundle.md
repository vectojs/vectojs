---
"@vectojs/core": patch
---

Three browser-robustness fixes:

- **WebGPU particle canvas was blurry on HiDPI** — the `gpuCanvas` backing store was sized in logical pixels (`width`/`height`) and then CSS-stretched, so on a 2× display it rendered at half resolution. It now sizes the backing store to logical × effective DPR (clamped to `maxDPR`, matching `CanvasRenderer`) with the CSS box at the logical size, both at creation and on `resize()`.
- **Physics jumped on tab refocus** — the render loop fed the full elapsed time into `update(dt)` and property drivers, so a backgrounded tab (rAF paused for seconds) advanced everything by that entire gap on the first frame back (springs explode, tweens snap past their end). `dt` is now clamped to a 100 ms max-frame cap, so a stall advances at most one slow frame; frame-rate telemetry still uses the true elapsed time.
- **Embedded (`disableWindowResize`) scenes never resized** — they only listened for `window` `resize`, which never fires when it's the canvas _element_ (not the window) that changes size. Embedded scenes now attach a `ResizeObserver` to the canvas and re-run `resize()` at its new logical size, disconnected on `destroy()`.
