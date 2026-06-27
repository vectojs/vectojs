---
'@vecto-ui/core': patch
'@vecto-ui/ui': patch
---

Text flow around exclusion rects (战役一, PR B — "文字绕流" v1): text can now wrap around rectangular regions, like CSS floats.

- **`@vecto-ui/core`**: new pure `computeLineSegments(top, bottom, maxWidth, exclusions)` returns the free horizontal segments left on a line after subtracting the `ExclusionRect`s that overlap its band (left/right floats narrow the line; a centered rect splits it in two; a full-width one skips the band). `LayoutEngine.layoutPrepared` takes an optional third `exclusions` argument and flows words across those per-line segments. New exports: `ExclusionRect`, `LineSegment`, `computeLineSegments`. The single-column path (no exclusions) is byte-for-byte unchanged.
- **`@vecto-ui/ui`**: `RichText` gains an `exclusions` option and a `setExclusions()` method.
