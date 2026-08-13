---
'@vectojs/ui': patch
---

Fix an infinite loop in `Entity.destroy()` when a `ScrollView`'s internal content layer was destroyed leaf-first. `ScrollView.remove()` redirected every child to `this.content.remove(child)`, so when the content layer self-detached inside its own `destroy()` (a leaf-first tree teardown that walks children before parents), `content.remove(content)` was a no-op and the destroyed content stayed in `ScrollView.children`. `Entity.destroy()`'s drain loop (`while (children.length > 0) children.at(-1).destroy()`) then spun forever because the already-destroyed child returned immediately without detaching, freezing the page main thread. `ScrollView.remove()` now detaches direct children (the content layer) via `super.remove()` and only routes nested children through the content layer.
