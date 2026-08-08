---
"@vectojs/core": patch
---

feat(core): add WheelEvent.deltaMode getter to VectoJSEvent

Exposes the native `deltaMode` property (0=pixels, 1=lines, 2=pages) so scroll widgets can convert wheel deltas correctly. Previously, widgets treated all `deltaY` values as pixels, causing line-mode and page-mode wheels to scroll at ~1-3px per notch instead of the expected ~48px or one viewport height.
