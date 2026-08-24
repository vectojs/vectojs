---
'@vectojs/styles': patch
---

fix(styles): theme var() tracking no longer retains destroyed entities strongly (#644)

`varPairs` was `WeakMap<Theme, Map<Entity, …>>` — only the outer key was weak,
so the inner map held every styled entity strongly for the lifetime of its
theme. `Entity.destroy()` has no hook back into styles, so destroyed entities
stayed reachable and every `setTheme` re-resolved and re-wrote their styles
forever; retention grew unboundedly with styled-entity churn while a theme
stayed active. Entities are now tracked through stable `WeakRef`s (dead entries
swept during the setTheme walk) and a new exported `untrackVarStyles(entity)`
gives frameworks an eager, deterministic release path for destroy teardown.
