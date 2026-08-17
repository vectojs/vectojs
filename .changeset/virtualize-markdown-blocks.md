---
'@vectojs/markdown': minor
'@vectojs/ui': minor
---

Markdown gains an opt-in `virtualize` option that materializes only the
top-level blocks near the viewport of a very large document, representing
off-screen height as numeric offsets (no wrapper entities) via a reused
`RowHeights` Fenwick tree. The host drives the window with
`Markdown.setVisibleRange(scrollY, viewportHeight)`; `ScrollView` now pushes
that range automatically when its content exposes `setVisibleRange`
(`ScrollVirtualizable`). Off-screen height is estimated from the token source
and refined to the exact measured height on mount. Streaming
(`createStream`/`appendMarkdown`) is not supported together with `virtualize`.
