---
"@vectojs/core": patch
---

Recover from Canvas2D context loss (`CanvasRenderer`). A GPU reset or memory-pressure `contextlost` on the 2D canvas would previously leave the scene permanently blank — the renderer kept issuing draw calls against a dead context. It now listens for `contextlost`/`contextrestored`: on loss it calls `preventDefault()` (required, or the browser never fires `contextrestored`) and marks the context lost so `clear()` and the render pass become no-ops; on restore it re-acquires the 2D context, re-applies the DPR transform, drops cached style, and fires an `onContextRestored` callback that `Scene` uses to repaint the (freshly cleared) canvas. `IRenderer` gains optional `isContextLost()` / `onContextRestored()`, and `Scene.render` skips a pass while any renderer reports its context lost. No-op where the canvas has no `addEventListener` (SSR).
