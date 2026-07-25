---
"@vectojs/three": patch
---

`ThreeRenderer` now recovers from WebGL **context loss** and tracks **runtime
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
