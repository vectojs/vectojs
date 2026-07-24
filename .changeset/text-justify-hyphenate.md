---
"@vectojs/ui": minor
---

`Text` now accepts `textAlign: 'left' | 'justify'` (+ a `setTextAlign()` method) and a `hyphenate` word-splitter. Left-aligned text keeps the fast one-`fillText`-per-line path; when justify or hyphenate is active, `Text` switches to a glyph-accurate render path (justify widens inter-word gaps flush to `maxWidth`, hyphenate breaks an overflowing word with a visible `-`). The DOM content projection still reports the original text unchanged, so find-in-page, selection, and screen readers are unaffected.
