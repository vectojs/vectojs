---
"@vectojs/markdown": patch
---

Repaint a paragraph image whenever its bitmap settles, not only when the bitmap
reports a usable intrinsic size.

`paragraphImage`'s `onLoad` called `scene.markDirty()` from inside a
`naturalWidth && naturalHeight` check, so a source that loads successfully while
reporting a zero dimension left the scene unnotified. An `onDemand` scene
repaints only when marked, so nothing that changed at decode time was drawn. The
display-math sibling already called it unconditionally, with a comment naming
this exact hazard — the two call sites disagreed, and this aligns them.

The trigger was identified by measurement rather than assumption. An
`<svg width="0" height="0">` is the one shape that fires `onload` with
`naturalWidth === 0` on both Chromium and Firefox. A dimensionless SVG is not:
no `width`/`height`, `viewBox`-only, and `width="100%"` all fall back to the CSS
default 300x150 and pass the check. A cross-origin raster is not either. A broken
source reports zero but settles as `error`, so the callback never runs.

Sizing behaviour is unchanged: a bitmap with a usable intrinsic size still
corrects the box, and a zero-dimension bitmap still keeps its initial estimate.
Covered by a new real-browser gate, `e2e/paragraph-image-repaint.e2e.ts`.
