---
"@vectojs/ui": minor
"@vectojs/markdown": patch
---

Reuse a streamed markdown table instead of rebuilding every cell.

`Table` gains a public append-only `appendRows(rows)`. It reproduces exactly what
the constructor does per row — normalize to the header's column count, reject a
duplicate `Entity` cell, apply `selectable`, mount to the right parent for the
current mode — then re-resolves geometry through `layout()`. It writes both the
public `rows` and the private cell grid: `layout()` walks the grid while
`getA11yAttributes()` counts `rows`, so updating only one produces a table that
either renders rows it does not announce or announces rows it does not render.

Append-only is deliberate. Existing row indices keep their meaning, so the roving
tab stop cannot be invalidated and no `detachA11y` bookkeeping is needed. To
change an existing cell, mutate the cell entity you passed in and call `layout()`,
which re-measures from `cell.height`.

`@vectojs/markdown` uses it for the last block type that still rebuilt. A `table`
token carries every row, so the old path cost Θ(C·N²) cell constructions across a
stream, plus a further 2× because `Table.layout()` re-runs `fitCell` on each one.
Measured on real Chrome and Firefox with a growing-table benchmark shape,
reuse-eligible on 27 of 36 chunks:

| growing table | reconcile              | total                   |
| ------------- | ---------------------- | ----------------------- |
| Chrome        | 156.6 → 44.8 ms (−73%) | 314.8 → 193.8 ms (−41%) |
| Firefox       | 98.0 → 29.3 ms (−70%)  | 250.5 → 177.1 ms (−28%) |

Total moves as well as reconcile, because the rebuild was discarding and
re-creating every cell entity.

Handling row appends alone would not have delivered this. `marked` materializes a
partially-arrived row immediately as a full row padded with empty cells and then
fills them one at a time — a 2×2 table passes through eleven distinct row states,
of which only two are clean appends. So the reuse path also rewrites the last
row's cells in place, and markdown now renders every table cell as a `RichText`
rather than letting an empty cell become a `Text`: `Text` has `setText`,
`RichText` has `setSpans`, and nothing converts between them, so a cell that
starts empty and later gains content could not otherwise be updated in place.
