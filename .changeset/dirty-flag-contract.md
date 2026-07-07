---
'@vectojs/core': patch
---

markDirty() calls made inside update() now survive to the next frame instead of being wiped at end of tick; CPU-fallback particles render and simulate in a consistent coordinate space for transformed entities; Entity.destroy() settles pending animateTo/springTo promises; SVGRenderer.arc matches Canvas sweep semantics for CCW and wrapped arcs; MSDF text wrap width is configurable via maxWidth/setMaxWidth.
