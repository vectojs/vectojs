---
"@vectojs/core": minor
---

Make `SVGEntity` visible when a source cannot be rasterized, and repair sources
that omit the SVG namespace.

`render()` previously had no branch after its bitmap/element checks, so any
raster failure left a permanently blank box of correct size — indistinguishable
from correct output. Two changes:

- Markup written without `xmlns="http://www.w3.org/2000/svg"` is now repaired.
  It parses as well-formed XML and yields correct dimensions, but the browser's
  image decoder rejects the blob, so it used to render nothing. It now
  rasterizes the real artwork. This is reachable from ordinary Markdown: a raw
  inline `<svg>` block becomes an `SVGEntity`, and hand-written SVG commonly
  omits the namespace.
- Genuinely undecodable input now draws a fallback marker (box outline plus a
  diagonal cross) instead of nothing, configurable via the new `fallbackStroke`
  and `fallbackFill` properties — set both to `'transparent'` to opt out. Both
  async failure handlers now also call `scene.markDirty()`, without which an
  `onDemand` scene never repainted.

New `hasRasterBitmap()` and `hasRasterFailed()` accessors report raster state.
Covered by `e2e/svg-fallback.e2e.ts`, which counts real pixels on Chromium and
Firefox.
