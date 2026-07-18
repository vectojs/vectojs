---
'@vectojs/ui': patch
---

Keep nested ContextMenu overlays semantically distinct and lifecycle-safe by
sharing one root backdrop and closing or destroying the complete menu chain.
