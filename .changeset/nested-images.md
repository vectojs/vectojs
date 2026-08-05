---
"@vectojs/markdown": patch
---

Render images nested inside links, emphasis and list items

`paragraphHasImage` and the paragraph render arm both tested
`token.tokens?.some((c) => c.type === 'image')` — **direct children only** —
while `marked` nests an image as deeply as the source does:

| source           | token shape                               |
| ---------------- | ----------------------------------------- |
| `![a](u)`        | `paragraph > image`                       |
| `[![a](u)](d)`   | `paragraph > link > image`                |
| `- item ![a](u)` | `list > list_item > text > [text, image]` |

Any nesting therefore failed the predicate, fell through to `inlineRunRichText`,
which has no image support, and the image vanished with no warning. This is the
same shape of defect as the list-item block children fixed earlier: a predicate
over direct children gating a construct that legitimately nests.

The predicate now recurses over descendants, and the render arm flattens nested
images to the top of the inline run before splitting it, so an image inside a
link, inside emphasis, or several levels down all reach `paragraphImage`. A
wrapper that also held text is replaced by its children rather than dropped, so
the prose around the image survives; a wrapper with no image keeps its own token
and therefore its styling and click handling.

A list item needs one more step, because its lead run carries the marker and is
one `RichText`. The lead keeps its prose with images stripped out, and those
images render as blocks beneath it. Excluding the whole child from the lead
instead does not work: an empty lead makes `listItemSpans` fall back to the
item's **raw** `text`, which rendered `- item ![a](u)` as literal Markdown source
above the correctly-split block.

Reference-style `![alt][id]` was reported as a third failing form. It is not: the
token is `paragraph > image` with `href` resolved, byte-identical in shape to a
working plain image, and it renders both one-shot and streamed. A regression test
records that so it is not re-investigated.
