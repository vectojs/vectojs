---
'@vectojs/ui': patch
---

Fix Slider drag sticking after pointercancel (#678)

Slider cleared `isDragging` only on `pointerup`, so a canceled touch/pen
gesture left the slider in dragging state and every later hover
`pointermove` scrubbed the value without a button pressed. The same
missing `pointercancel` guard in ScrollView's and VirtualList's
drag-scroll end handlers is included.

Fixes #678
