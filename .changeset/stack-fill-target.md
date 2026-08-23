---
'@vectojs/ui': minor
---

Add a `fillTarget` option to `Stack` for fill-remaining layouts.

When `fillTarget` is set (and `wrap` is false), `layout()` stretches the LAST
child along the main axis so the children plus gaps total exactly `fillTarget`,
floored at that child's content size — it never shrinks below its own content,
so insufficient space overflows the container while the container still reports
exactly `fillTarget` along the main axis. This enables fill-remaining layouts
(e.g. a footer/list filling the rest of a fixed panel) without hand-rolled
per-render resize loops.

Other children keep their sizes and only their positions are set, as before.
While the option is set, Stack's O(1) incremental append paths (`add`
fast path, wrap fast-append, `resizeLastChild`) automatically fall back to a
full `layout()`; with the option unset, behavior and performance are unchanged.
