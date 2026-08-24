---
'@vectojs/layout': patch
---

`suppressLineBreaks` merges now carry hyphenation across the merge: Rule 1 (`@` + following identifier words) re-bases each merged word's `breakPoints` by the glyph offset, and Rule 2 (orphan punctuation onto the preceding word) keeps the preceding word's soft-hyphen/hyphenator breaks and shifts the punctuation-side ones. Authored breaks in tokens like `internal\u00ADly,` or `@inter\u00ADnal` are honored at wrap time again.
