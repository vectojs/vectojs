---
"@vectojs/markdown": minor
---

Render block-level children of list items instead of flattening them to text

A list item was built as a single inline `RichText`, so any block-level child —
a `$$…$$` display formula, a fenced code block, a table, a blockquote, an `hr`,
a nested list, or a second paragraph — fell through to its raw source and was
painted as literal characters. Parsing was never at fault: marked does emit a
`blockMath` token as a sibling of the item's inline content; the renderer had no
branch for it.

Measured on a real 60-line document, 9 of its 10 display formulas were affected:
the one at indent 0 rendered, and every one at indent 2 inside a list item did
not. The discriminator was list membership, not the formula.

An item holding a block now becomes a vertical `Stack` — its lead inline run
carrying the marker, then each remaining child rendered through the same
`renderToken` the document level uses, indented to clear the marker. Nested
lists, which previously vanished entirely, now render.

Inline-only items keep the single-`RichText` fast path, which is what
`updateStreamedList` reuses via `setSpans`; the streamed path is tiered the same
way and promotes an item off the fast path when its `$$` or fence closes
mid-stream.
