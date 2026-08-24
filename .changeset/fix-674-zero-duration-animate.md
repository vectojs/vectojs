---
'@vectojs/core': patch
---

core: `Entity.animate()` treats zero, negative, and non-finite durations as an immediate terminal write of the target values (#674). They previously computed `0/0 = NaN` progress on the first tick, corrupted animated properties with NaN, and permanently jammed the tween queue.
