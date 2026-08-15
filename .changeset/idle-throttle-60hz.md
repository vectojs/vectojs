---
'@vectojs/core': minor
'@vectojs/ui': patch
---

Change the `'always'`-mode idle auto-throttle floor from 2 FPS to 60 FPS. An idle scene previously crawled at ~2 FPS by default, which read as a broken app for anything with ambient animation — and completely froze imperative-draw apps that never call `markDirty()` or override `hasPendingAnimations()`. The new `SceneOptions.idleFPS` (default 60) sets the idle floor; set it to `2` to restore the legacy aggressive sleep as an explicit developer choice. `autoThrottle: false` still disables the idle cap entirely, and `onDemand` is unchanged (zero idle frames).
