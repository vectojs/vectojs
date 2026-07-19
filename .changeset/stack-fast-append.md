---
'@vectojs/ui': patch
---

Fix `Stack.add()` performing a full O(children) `layout()` on every single call, which made total layout cost for an N-child stack scale as O(N^2). Streamed content built by repeated `add()` calls (e.g. one Markdown paragraph per token) now appends in O(1) for the common case (no `wrap`, `align: 'start'`), falling back to a full `layout()` for wrapping, non-start alignment, or right after a `remove()` (to resynchronize stale size/position state). `Flow` (always `wrap: true`) is unaffected.
