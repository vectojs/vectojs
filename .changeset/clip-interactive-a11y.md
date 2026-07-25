---
"@vectojs/core": patch
---

Clip interactive a11y projections by `clipChildren` ancestors and the viewport. `Scene.syncA11y` positioned each interactive entity's transparent shadow element but never gated its visibility, so a `Button` (or any interactive control) scrolled out of a `ScrollView`/`VirtualList` stayed clickable, focusable, and announced to screen readers — and could intercept clicks over whatever was drawn on top of it. The interactive branch now applies the same exact (margin 0) `projectionBoxVisible` test the content-projection branch already used, hiding the mirror with `display:none` when the entity's world box is fully outside its `clipChildren` ancestors or the viewport, and restoring it when it scrolls back in. `a11yFullViewport` overlays are intentionally exempt (they are unbounded by design).
