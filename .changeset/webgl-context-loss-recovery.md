---
"@vectojs/core": patch
---

Recover the WebGL point layer from a GPU context loss (driver TDR reset, tab backgrounded on mobile, GPU switch). `WebGLPointRenderer` never handled `webglcontextlost`/`webglcontextrestored`, so after a context loss the layer stayed permanently blank — and, critically, without calling `preventDefault()` on the `lost` event the browser never fires `restored` at all. `Scene` now attaches recovery listeners to its WebGL canvas: on `webglcontextlost` it calls `preventDefault()` and drops the (now-dead) renderer so the render loop skips the layer; on `webglcontextrestored` it rebuilds the renderer from scratch via the registered creator, restores DPR/size, and repaints. Listeners are removed on `destroy()`, and a `restored` event that arrives after teardown is inert. (The `@vectojs/three` renderer, which has its own Three.js restore machinery, is a separate follow-up.)
