---
'@vectojs/core': patch
---

Fix `CanvasRenderer.resize()` leaving the cached font/fill state stale across the backing-store resize. Setting `canvas.width`/`canvas.height` resets the whole 2D context state per spec (font to `10px sans-serif`, `fillStyle` to black); `resize()` re-applied only the DPR scale, so the first `fillText`/`fill` after a resize with the same font/color string as the cache skipped the assignment and painted with the reset defaults — a single-font app stayed on the default font forever. `resize()` now drops the cached font/fill and batch state, mirroring what the `contextrestored` handler already does for a lost context.
