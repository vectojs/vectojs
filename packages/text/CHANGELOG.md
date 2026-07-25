# @vectojs/text

## 0.2.0

### Minor Changes

- 2bebe0c: Rewrite `BidiResolver` onto bidi-js's authoritative UAX #9 reorder and expose the source↔visual mapping selection needs.

  - **Complete L1**: `reorderVisual` previously hand-rolled the L1 whitespace/segment-separator reset and only reset a single trailing-whitespace run (a known partial-L1 gap). It now delegates to bidi-js's `getReorderSegments`, so trailing whitespace, tabs, and segment separators inside a run are reset to the paragraph direction correctly. Behavior is unchanged for the LTR/RTL/mixed cases the existing tests and layout pipeline already covered (verified against the full text/layout/ui suites); a per-run reorder now provably agrees with a full-line reorder.
  - **New source↔visual mapping API** (the primitive correct RTL/Arabic selection rectangles are built from): `BidiResolver.reorderIndices(text)` returns the visual-order→logical-index permutation, and `BidiResolver.logicalToVisualRuns(text, start, end)` maps a logical range to the merged, left-to-right set of contiguous VISUAL runs it occupies — a single run for pure LTR/RTL, and the visually-disjoint rectangles a bidi selection must paint when the range straddles a direction boundary (e.g. Latin digits inside RTL Arabic).
  - `reorderVisual` is now generic over `{ char; level }` (accepts any layout-node array) and the `BidiNode` / `VisualRun` types are exported.

- c5c720a: Fix the zero-GC buffer layout path dropping BiDi reordering and the mixed-size
  baseline. `LayoutEngine.layoutPreparedIntoBuffer` (the per-frame path for large
  dynamic scenes) wrote glyphs in **logical** order at a single paragraph
  `fontSize`, so RTL text came out reversed and left-aligned, and mixed-size inline
  runs were positioned at the raw line top instead of a shared baseline — both
  already correct in the allocating `layoutPrepared`.

  The buffer path now mirrors it: per-line slots are reordered to visual order
  (UAX #9 L2) with the whole line flushed right for an RTL paragraph, and each
  glyph keeps its own size as `height` with a `(lineMax - size) * 0.8` baseline
  offset. A `levels` array on `LayoutResultBuffer` records each glyph's resolved
  embedding level (so consumers can tell direction per glyph). A pure-LTR line —
  the common hot path — skips the reorder entirely and stays allocation-free.

  `BidiResolver.reorderSegments(str, levels, baseLevel)` is new: it exposes the L2
  reversal segments so a caller holding parallel typed arrays can apply the same
  permutation in place without allocating a node per glyph. `reorderVisual` now
  delegates to it (behavior unchanged).

### Patch Changes

- 539700d: Fix four text-rendering defects found by verifying the suspected-issues list
  (a fifth turned out to be a false positive):

  - **MSDF missing glyphs collapsed the line** (`@vectojs/text`). A codepoint absent
    from the atlas (e.g. CJK in a Latin font) advanced the pen by zero, pulling
    every following glyph left and under-reporting `width`. It now advances by a
    substitute (the font's own space advance, else `.notdef`, else 0.5em) so the
    rest of the line stays put.
  - **MSDF combining marks took a full advance** (`@vectojs/text`). A nonspacing
    mark (category Mn) must not move the pen — it stacks on its base glyph — but a
    nonzero atlas advance was applied, rendering `é` (e + U+0301) as two glyphs side
    by side. Marks are now clamped to zero advance (and a _missing_ mark reserves no
    substitute advance either).
  - **CRLF `\r` was laid out as a glyph** (`@vectojs/layout`). Splitting the source
    on `'\n'` left the `\r` at the end of each paragraph, where it was shaped into a
    real node — a visible tofu box that also inflated the line width and shifted
    selection. All line-ending forms (`\r\n`, `\n`, lone `\r`) now end a paragraph
    and are excluded from shaping, while `sourceIndex` still indexes the original
    text (a CRLF break correctly accounts for both characters).
  - **RTL + justify was flush on only one edge** (`@vectojs/layout`). A justified RTL
    line skips the whole-line flush-right shift, but its logical trailing space (L1-reset
    to the base level) lands at the visual left and kept its width, so content began a
    space-width inside the measure. Leading visual whitespace is now collapsed, making
    justified RTL lines flush on both edges; LTR justify and non-justified RTL are
    unchanged.
  - **Unterminated quotes swallowed the rest of a code line** (`@vectojs/markdown`).
    `highlightLine` colored from any opening quote to end-of-line even when it never
    closed, so a Rust lifetime (`&'a str`) or a stray apostrophe turned the remainder
    green. A quote is now a string delimiter only when it closes on the same line.

- 63fc4b7: Two text-correctness fixes.

  **Text-default pictographs no longer count as double-width** (`@vectojs/text`). `PreparedContentGrid`'s `isWideCluster` treated every `Extended_Pictographic` code point as width-2, but `© ® ™ ☺ ✔ ❤` (and many others) are _text-default_ — width-1 unless an emoji variation selector (VS16) forces emoji presentation. This drifted the caret in the monospace content grid. A pictograph is now wide only when it carries VS16 or is `Emoji_Presentation` by default (and VS15 forces it narrow); flags, keycaps, and CJK are unaffected.

  **Inline `code` now renders (and measures) as monospace** (`@vectojs/layout`, `@vectojs/ui`, `@vectojs/markdown`). `TextStyle` gains an optional `fontFamily`, and `GlyphMeasurer.measure` gains an optional `fontFamily` argument, so a run in a different family lays out at its own metrics instead of the base font's. `RichText` honors it in both drawing (`nodeFont`) and measurement, and Markdown inline `codespan` now sets `fontFamily` to the theme's monospace stack — previously inline code was only tinted, rendered in the proportional prose font. Fenced `CodeBlock` was already monospace and is unchanged. Runs without `fontFamily` keep the component's base family (no behavior change for existing callers).

## 0.1.0

### Minor Changes

- 3a623c1: Introduce `@vectojs/text` as a standalone package of renderer-agnostic
  text-shaping primitives: `BidiResolver`, `ArabicShaper`, `Typography`
  (CSS-parity line-box metrics), `MSDFFont`, and `PreparedContentGrid`. Extracted
  from `@vectojs/core` (they have no dependency on the scene graph or a renderer).
  The `Entity`-based `MSDFTextEntity` / `SVGEntity` stay in `@vectojs/core`, which
  re-exports everything here for backward compatibility.
