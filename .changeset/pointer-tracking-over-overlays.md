---
"@vectojs/core": patch
---

Fix `scene.mouseX`/`mouseY` (and pointer-driven particle repulsion) freezing
when the cursor is over projected text or an interactive a11y mirror. Those
overlay elements sit above the canvas with `pointer-events: auto`, so a
`pointermove` over them fired on the element and never reached the
canvas-bound listener. The pointer listeners are now attached to the canvas's
parent container, so moves over any layer keep the tracked position current;
`pointerleave` still resets only when the pointer exits the whole region.
