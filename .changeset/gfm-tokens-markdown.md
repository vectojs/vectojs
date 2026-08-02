---
"@vectojs/markdown": minor
---

Render the three GFM constructs the lexer already produced but the renderer discarded.

No parser work was involved — `marked` emits all three and `renderToken`/`collectSpans`
simply had no case for them, so each failed in a way that looked like plain output
rather than a missing feature:

- **Strikethrough.** `~~gone~~` lexes to a `del` token, which fell through to the
  default arm and pushed its text unstyled, so the content rendered without a line.
  Nested emphasis and a struck link (`~~[x](url)~~`, a `del` wrapping a `link`) both
  keep their own styling.
- **Task lists.** `- [ ] todo` carries `task`/`checked` on the item; nothing read
  them, so no box was drawn. A task item now shows ☐/☑ in place of the bullet
  (matching GitHub, which suppresses the bullet for a task list) and after the
  number in an ordered list. The box follows the same reading-direction rule as the
  bullet, so an RTL item shows it on the visual right, and a loose list renders
  identically to a tight one — `marked` puts its `checkbox` token at a different
  depth for each, which is why `item.task` is the source rather than that token.
- **Table alignment.** `| :--- | :---: | ---: |` resolves to `align` on the token
  and was dropped, so every column rendered left-aligned. It is now forwarded to
  `@vectojs/ui`'s new `TableOptions.align`. A streamed table rebuilds rather than
  reusing when alignment changes, which is reachable mid-stream: `| --- | ---`
  already lexes to a table, and a colon arriving in the next chunk re-lexes the same
  table with new alignment.
