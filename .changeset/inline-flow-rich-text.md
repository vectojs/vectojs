---
'@vecto-ui/core': patch
'@vecto-ui/ui': patch
---

Inline rich-text flow (战役一, PR A): bold / italic / colored / differently-sized runs that flow and wrap on the same lines, sharing a baseline.

- **`@vecto-ui/core`**: new `LayoutEngine.prepareRich(spans, atlas, baseFontSize, baseStyle?)` cold pass taking `StyledSpan[]`. Each grapheme carries the (base-merged) `TextStyle` of the span it came from — so a style change _mid-word_ is honored — and is measured at its run's `fontSize`. `layoutPrepared` now baseline-aligns mixed sizes (tallest run on a line drives line height; smaller glyphs drop to the shared baseline) and carries `style` onto each `LayoutNode`. New exports: `TextStyle`, `StyledSpan`; `PreparedGlyph`/`LayoutNode` gain an optional `style`. Plain (single-style) layout is unchanged.
- **`@vecto-ui/ui`**: new `RichText` component — renders styled runs via the engine's rich path, drawing each glyph with its run's color and weight/slant.
