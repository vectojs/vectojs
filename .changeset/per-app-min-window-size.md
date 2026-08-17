---
'@vectojs/desktop': minor
---

`AppDefinition` gains optional `minWidth`/`minHeight`: the effective window floor becomes `max(theme-min, app-min)`, applied on open, `setGeometry`, and edge resize — so tiling and snapping never shrink a window below its content.
