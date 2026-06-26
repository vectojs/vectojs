---
'@vecto-ui/core': patch
---

Support full-viewport / boundless interactive entities in the a11y layer.

Add `Entity.a11yFullViewport`: an interactive entity with no intrinsic box
(`width`/`height` of `0`) — e.g. an infinite-canvas graph — can now opt into a
viewport-filling shadow node so it receives global pointer events. Previously
`Scene.syncA11y` skipped any entity with `width === 0`, so such surfaces lost all
DOM-routed pointer events. The full-viewport node mounts behind all other shadow
nodes, so on-top components stay clickable, and uses the default cursor.
