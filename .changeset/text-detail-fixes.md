---
"@vectojs/text": patch
"@vectojs/layout": patch
"@vectojs/markdown": patch
---

Fix four text-rendering defects found by verifying the suspected-issues list
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
