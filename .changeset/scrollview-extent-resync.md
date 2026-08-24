---
'@vectojs/ui': patch
---

Resync ScrollView extent when a child resizes in place (#685)

`updateContentSize()` ran only from `add()`/`remove()`, so a child growing via
`append` (streaming text) raised its own height without the ScrollView noticing:
clamping capped scrolling at the old extent, leaving new bottom content
unreachable — and a shrink allowed scrolling into blank space. The per-frame
content loop now polls children extents and resyncs (with re-clamp) when they
differ.
