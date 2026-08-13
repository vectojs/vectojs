---
'@vectojs/devtools': patch
---

Four P2 fixes from the 2026-08-13 code review: snapshot diffing no longer pairs a node twice or drops removals on mixed keyed/unkeyed sibling levels; armed pick mode ignores clicks on the panel's own controls instead of consuming them; `findEntityAt` now applies the engine's opacity, clip-ancestor, and pointer-transparent rejection gates so the inspector picks what a click would hit; a11y canvas-vs-DOM drift comparison normalizes the projected node's client rect back to scene units (CSS-scaled canvases no longer report false drift).
