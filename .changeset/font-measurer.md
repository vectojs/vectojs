---
'@vecto-ui/core': minor
---

Add real font metrics for non-atlas text via a canvas-backed glyph measurer.

- New `createCanvasMeasurer(fontFamily?, baseSize?)` returns a `GlyphMeasurer`
  that measures each grapheme once with canvas `measureText` (cached, scaled
  linearly by font size), or `null` in DOM-free environments.
- `LayoutEngine` accepts an optional measurer; glyph width now resolves in
  priority order **atlas → measurer → `0.5em` fallback**, fixing line-breaking
  for text without a pre-baked vector atlas.
- `TextEntity` wires a shared `sans-serif` measurer by default, so it lays out
  with real metrics out of the box.

Validated against DOM ground truth: empty-atlas line-count error dropped from
−50%…+27% to **0%** (matching the real-atlas path) across Latin and CJK; the
remaining Arabic gap is bidi/shaping, not measurement.
