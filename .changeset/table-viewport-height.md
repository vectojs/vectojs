---
'@vectojs/markdown': minor
---

Add `MarkdownOptions.tableViewportHeight`, so a Markdown table can use
`@vectojs/ui` `Table`'s row virtualization.

Previously `Markdown` never passed `viewportHeight` when constructing a table,
so every Markdown table ran in `Table`'s grow-to-fit mode and pooled a `row`
plus one `gridcell` per column for **every** row it held. The projected a11y DOM
therefore grew linearly with row count: measured 30 / 150 / 600 `gridcell`
hotspots for 10 / 50 / 200 data rows. With a viewport height set the pool is
bounded by the visible window instead, and 200 rows costs the same as 50.

Off by default, and opt-in rather than automatic: a virtualized `Table` fixes its
height to `viewportHeight` and scrolls its body internally, so enabling it would
change document layout, not just cost. It applies to every table in the document
once set — including one that lexes with zero rows — because `Table` takes
`viewportHeight` as `readonly`, and every streamed table starts empty and grows
through `appendRows`.

Unrelated to `MarkdownOptions.virtualize`, which windows top-level blocks and
cannot be combined with streaming. This option windows rows inside a single
table and works mid-stream.

Closes #593.
