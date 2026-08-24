---
'@vectojs/devtools': patch
---

fix(devtools): tree labels track animated geometry instead of going up to 3s stale (#706)

Tree node labels embed `(x,y) WxH` so geometry is readable without selecting,
but `refresh()` skipped the rebuild whenever `structureVersion` was unchanged —
and transforms never bump that version. Any animated, dragged or moved entity
kept showing the coordinates of its last structural change until the periodic
forced reconcile fired (~3s). `refreshTreeLabels` now rewrites the baked-in
labels in place on every version-gated tick (no node/index churn), and the
rebuild path shares one `geometryLabel` helper.
