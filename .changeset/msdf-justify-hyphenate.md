---
"@vectojs/layout": minor
"@vectojs/core": minor
---

Add justify alignment and soft-hyphen breaking to the MSDF text path, reaching parity with `TextEntity`.

- `LayoutWorker` gains a `textAlign: 'left' | 'justify'` request field. `'justify'` stretches every soft-wrapped line flush to `maxWidth` — widening inter-word spaces, or distributing slack between glyphs on a space-less CJK line — while paragraph-final and newline-ended lines stay ragged (matching `LayoutEngine`).
- `LayoutWorker` now honors soft hyphens (U+00AD) as break opportunities: when a word overflows, it breaks at the last soft hyphen that still fits and emits a visible `-` glyph, instead of moving the whole word down.
- `MSDFTextEntity` gains `setTextAlign('left' | 'justify')` (and a `textAlign` constructor option) plus `setHyphenator(fn | null)`. The hyphenator runs on the main thread (a function can't be structure-cloned into the layout worker), inserting U+00AD into the string sent to layout; the original text is preserved for accessibility / content projection.
