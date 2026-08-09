---
'@vectojs/core': patch
---

Stop the a11y and portal overlays drifting from a `position: fixed` canvas during
scroll.

A pinned full-viewport canvas is composited against the viewport by the browser,
instantly and off the main thread, but the overlay layers were always
`position: absolute` — laid out against the scrolling document. Keeping them
together meant re-deriving `top` from the parent's rect and writing it once per
rendered frame, so any frame where scroll advanced before the render loop ran
left the overlay stale by that frame's whole scroll delta and a selection
highlight visibly detached from its glyphs.

The overlay layers now share the canvas's positioning scheme, which removes the
per-frame dependency instead of syncing more often. Measured on a live
full-viewport scene under real smooth scroll over 630px: one frame misaligned by
64.8px before, worst misalignment 0.000px after. An in-flow canvas keeps the
existing parent-relative behaviour.
