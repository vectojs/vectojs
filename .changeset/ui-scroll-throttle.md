---
'@vectojs/ui': patch
---

- `VirtualList` and `TreeView` scroll animations are now visible to the Scene's idle throttle / onDemand skip via `hasPendingAnimations()` — smooth scrolling no longer steps at 2 FPS (or stalls in onDemand mode) once the throttle engages. Same regression class as the earlier ScrollView fix.
- `Tooltip` restarts (instead of stacking) its show-delay timer on repeated hover, and cancels it on `destroy()`.
