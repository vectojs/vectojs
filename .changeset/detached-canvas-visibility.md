---
'@vectojs/core': patch
---

Do not observe a detached canvas for visibility.

`Scene.start()` watches the canvas with an `IntersectionObserver` so the rAF
loop can pause while the canvas is scrolled out of view. A canvas that is never
appended to the document — one used purely as a texture source, such as the
offscreen canvas `@vectojs/three`'s `ThreeAdapter` wraps in a `CanvasTexture` —
is reported as not intersecting, so the loop paused itself on the observer's
first callback and never resumed: the only resume path is an `isIntersecting`
transition, which a detached element cannot produce. Such a scene rendered at
most one frame, and `markDirty()` from input handlers set a flag on a loop that
would never run again.

The observer is now skipped when the canvas is explicitly not connected. A
detached canvas is always treated as visible, because whether its output is seen
depends on the consumer sampling the texture, which the scene cannot observe.
