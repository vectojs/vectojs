---
'@vectojs/core': minor
'@vectojs/ui': patch
'@vectojs/markdown': patch
---

feat(core): `ContentProjectionHint.textOnly` so the coarse tier stops building discarded lines

A resident but off-viewport block (the coarse content tier) is projected as a
single text node — Scene writes `projection.text` and never reads `lines` or
`grid`. It nonetheless asked entities for a full projection, so every such block
ran its O(glyphs) layout walk on each synced frame and the result was discarded
on the same frame.

`ContentProjectionHint` gains `textOnly`, set by Scene for coarse-tier syncs.
`Text`, `RichText` and `CodeBlock` return text plus metrics and skip the line /
grid build when they see it. The hint stays advisory: an entity may ignore it and
return `lines` anyway, and the text is never narrowed, so find-in-page and
screen-reader read-ahead keep reaching off-screen content unchanged.
