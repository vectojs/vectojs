---
'@vectojs/core': patch
---

Fix projection follow-ups (CTX-0606, closes #860): explicit `dom` policy that falls back to canvas keeps its a11y mirror, `projectionHysteresisFrames` / `projectionAutoDomBudget` are recognized constructor options, and `Scene.destroy()` releases unreachable projection residents.
