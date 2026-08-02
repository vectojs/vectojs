---
"@vectojs/ui": minor
---

Paint strikethrough in `RichText`, and add per-column alignment to `Table`.

`RichText` renders `@vectojs/layout`'s new `TextStyle.lineThrough` as one line
stroked across each struck run. Unlike the link underline — which needs a segment
per glyph — a struck run is already coalesced, so one segment spans it; struck-ness
joins the coalescing key so a run is never part struck, and the line scales with
the run's font size rather than being a hairline on a heading. A struck link gets
both lines, which is reachable: `~~[x](url)~~` lexes to a `del` wrapping a `link`.

`TableOptions.align` (new exported type `ColumnAlign`) takes one entry per column
and accepts `'left' | 'center' | 'right' | null`, where `null` and a malformed or
short array mean the previous all-left behavior. Alignment is applied by
positioning each cell entity inside its column rather than by a text-align
property, because the text components accept only `'left' | 'justify'`. All three
positioning sites honor it — header, plain body, and virtualized body — so a
virtualized table cannot align differently from a plain one past the scroll
threshold. For a cell that wrapped to several lines this aligns the block, not each
line within it.
