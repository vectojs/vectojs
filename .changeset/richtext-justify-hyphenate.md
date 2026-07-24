---
"@vectojs/ui": minor
---

`RichText` now accepts `textAlign: 'left' | 'justify'` (+ a `setTextAlign()` method) and a `hyphenate` word-splitter. `justify` stretches every wrapped line flush to `maxWidth` (paragraph-final and newline-ended lines stay ragged); `hyphenate` breaks an overflowing word with a visible hyphen (soft hyphens U+00AD in the text work without one). Both pass straight through to the shared `LayoutEngine` — `RichText` already draws each glyph at its own position, so no rendering change was needed.
