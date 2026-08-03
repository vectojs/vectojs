---
"@vectojs/markdown": minor
"@vectojs/ui": minor
---

Add `Markdown.setMaxWidth()`, so a width change rewraps in place instead of
requiring a full document rebuild.

`Text` and `RichText` both had a `setMaxWidth`; `Markdown`, which composes them,
did not — and assigning `maxWidth` alone changed nothing visible, because the width
is read when each block is **built**. Measured before: `md.maxWidth = 300` left the
paragraph 465 wide and the document box 712.

The only correct workaround was a rebuild, and a real consumer had written one.
`vectojs-gallery`'s chat Creation released its stream, replayed every revealed
character through `setContent`, constructed a **new** stream writer because the old
one was bound to blocks `setContent` had just discarded, and carried its scroll
offset across by hand — on every resize frame that changed the width. That is now
unnecessary.

`setMaxWidth` walks the retained token list beside the existing child entities and
hands each block its new width, recursing into blockquotes and list/image stacks.
Nothing is re-lexed, no entity is destroyed or created, and an open `createStream`
writer stays valid because the block structure it is bound to is untouched.
`RichText`'s paragraph memo is keyed on content rather than width, so a re-wrap
reuses the shaping and pays only for line breaking.

Also adds two supporting primitives:

- **`Table.setWidth()`** — assigning `width` alone was not enough, because
  `colWidths` is resolved once in the constructor and every cell's wrap width,
  position and alignment derives from _those_ per-column figures. A `Table` whose
  `width` was reassigned painted its chrome at the new size while its cells stayed
  laid out for the old one. Columns rescale proportionally, so a caller-supplied
  ratio survives a resize rather than being re-split equally.
- **`CodeBlock.setWidth()`** — deliberately does not rebuild the grid or the
  highlight, because code does not reflow: lines sit on a fixed monospace grid and a
  long line overflows rather than wrapping, so height is a function of line _count_
  alone.

Verified by a new both-engines gate, `packages/markdown/e2e/set-max-width.e2e.ts`,
wired into `test:e2e`. Geometry alone is not the assertion there, because a rebuild
produces correct geometry too — which is exactly how a consumer ended up writing
one. It asserts the properties that distinguish a reflow from a rebuild: the same
entity **instances** survive (identity tokens, not counts), an open stream writer
stays `open` and keeps appending afterwards, and the lexer consumes **zero**
additional source characters. Measured: 520px/2 lines/h=88 → 260px/4 lines/h=160,
widest projected line 257.4 against the 260 wrap width, same 2 instances, stream
open, 0 extra characters lexed, identical on both engines. Confirmed to fail against
the pre-fix behaviour: 505.7px lines inside a 260px box.
