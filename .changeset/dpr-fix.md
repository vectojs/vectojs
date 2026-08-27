---
'@vectojs/core': patch
---

Fix white-screen and dead clicks after browser zoom / DPR change (CTX-0530).

`CanvasRenderer`/`CanvasGeometry` now guard `devicePixelRatio` against NaN/Infinity and round backing-store sizes, and `Scene.watchDevicePixelRatio` uses an epsilon (0.001) to ignore fractional-DPR jitter (1.1000000685 at 110% zoom) that previously caused continuous re-arm flicker. A polling fallback (1s, same epsilon) covers monitor moves and CDP emulation where the resolution media query doesn't fire, and `resize`/`handleResize` are wrapped so a failing rebuild never leaves the canvas blank. Fixes blank gradient and hit-test loss on zoom.
