---
"@vectojs/core": patch
---

Pause the render loop when the canvas scrolls fully off-screen. A running `Scene` requested a `requestAnimationFrame` every frame regardless of whether its canvas was visible, so a dashboard tab, a chart below the fold, or any scrolled-away scene kept paying the full per-frame update/render cost for something nobody could see. `Scene` now observes its canvas with an `IntersectionObserver`: while the canvas is off-screen the loop does no work and stops rescheduling, and the observer resumes it (resetting the frame clock) when the canvas re-enters the viewport. `markDirty()` calls made while hidden are preserved and consumed on the resume frame. No-op where `IntersectionObserver` is unavailable (SSR/tests), so that behavior is unchanged; the observer is disconnected on `stop()`/`destroy()`.
