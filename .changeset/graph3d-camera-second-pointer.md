---
'@vectojs/graph3d': patch
---

GraphCamera ignores a second pointerdown while a camera drag is active. The active drag keeps its pointer until its own up/cancel; previously the second contact overwrote lastX/lastY and pointerId, panning by the inter-contact distance in one lurch (two fingers, mouse + pen) and churning pointer capture.
