---
"@vectojs/ui": patch
---

Two per-frame `@vectojs/ui` hot paths that scaled with content size are now flat:

- **VirtualList row math**: `_totalH`/`_rowTop`/`_visibleRange` were O(items) and ran every scroll frame, defeating virtualization on long feeds. Replaced the height bookkeeping with a Fenwick prefix-sum tree (new exported `RowHeights`): `total()` O(1), `prefix()`/`indexAt()` O(log n), O(log n) point updates when a measured height replaces its estimate. Measured height caching and variable-row support are unchanged.
- **RichText per-frame rebuild**: `visualLineGroups()` rebuilt the visual-line grouping (an O(glyphs) walk with `Math.max(...map())` per line) on every `render()` and every content-projection call. It is now memoized on the layout-`result` identity and invalidated whenever `layout()` produces a new result.

Real-hardware benchmark (`benchmarks/ui-perf`, Chrome 150 + Firefox 153): VirtualList row math stays ~0.04–0.09 ms as the list grows while the previous linear scan reaches 391 ms (Chrome) / 165 ms (Firefox) at 500k rows — up to 4350× / 4130×. RichText memoized warm frames are ~0.0002 ms vs cold builds up to ~1.2 ms. Behavior is unchanged (all 357 ui tests plus new `RowHeights` and memoization regression tests pass).
