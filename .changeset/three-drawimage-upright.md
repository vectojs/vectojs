---
'@vectojs/three': patch
---

Fixed `drawImage` blits rendering vertically flipped under the y-down orthographic camera; images now land upright, matching the Canvas2D backend and the existing `fillText` convention.
