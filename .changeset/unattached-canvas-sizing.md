---
'@vectojs/core': patch
---

Scene no longer inherits the window viewport for an unattached canvas (#817). A full-window scene constructed before its canvas is attached now starts at 0×0 and adopts `window.innerWidth/innerHeight` through a one-shot ResizeObserver latch when the canvas first gains layout; an explicit `resize()` issued before attachment is respected and skips adoption. Attached-at-construction scenes and `disableWindowResize` scenes are unchanged.
