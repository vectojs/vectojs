---
"@vectojs/core": patch
---

Re-render on a runtime `devicePixelRatio` change. The DPR was applied only inside `renderer.resize()`, which fires on a `window` resize — but dragging the window to a monitor with a different pixel density, or a browser zoom that changes DPR without changing the logical size, left the canvas backing store rasterized at the old DPR and visibly blurry. `Scene` now arms a `(resolution: Ndppx)` media query for the current DPR and, on change, re-runs `resize(width, height)` (re-scaling the backing store) and re-arms a fresh query for the new ratio (a resolution query only fires when leaving its exact value). It runs even for embedded (`disableWindowResize`) scenes, since they blur the same way, and is torn down on `destroy()`. No-op where `matchMedia` is unavailable.
