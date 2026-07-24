---
"@vectojs/core": patch
---

Fix `Entity.destroy()` to recurse into the whole subtree instead of only tearing down the entity itself. Previously only `Scene.destroy()` walked the tree, so calling `entity.destroy()` — or `scene.remove(subtree)` on an SPA route change — stranded every descendant's GPU buffers, layout workers, and DOM observers (the root cause behind the MSDF worker, compute-particle GPU, DOM-portal observer, and streaming-Markdown leaks). `destroy()` is now the single leaf-first recursion point: it destroys descendants (deepest last-detached), then clears its own animations/drivers/listeners, then detaches from its parent. It is idempotent and re-entrancy safe via an internal guard, so subclasses that free a resource which is also a child (e.g. `ContextMenu`) no longer double-free. `Scene.destroyEntitySubtree` now delegates to `entity.destroy()`.
