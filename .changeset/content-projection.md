---
'@vectojs/core': patch
---

Static content projection: entities can expose rendered text via getContentProjection() and the Scene mirrors it as transparent, position-synced, viewport-lazy DOM nodes — canvas text becomes findable (Ctrl+F), readable by screen readers and crawlers, translatable, and optionally natively selectable. TextEntity and MSDFTextEntity opt in out of the box; disable per scene with contentProjection: false.
