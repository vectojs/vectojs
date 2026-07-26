---
'@vectojs/core': patch
---

Pin a11y projection gate symmetry and correct the `detachA11y` doc comment.

Nothing tested what happens when an entity stops satisfying the projection gate
(`interactive && (width > 0 || a11yFullViewport)`). Reading `syncA11y` alone
suggests a leak, since it only creates and updates — but it is always followed by
`enforceA11yDomOrder`, whose prune pass removes any element whose entity no longer
qualifies. Measured: `interactive = true` projects, flipping to `false` removes the
element on the next synced frame, and flipping back re-projects.

Adds tests for each transition, including a zero-width collapse, the
`a11yFullViewport` exception, and that focus moves to the sentinel rather than
`<body>` when a *focused* element is pruned.

`detachA11y`'s doc said "the per-frame `syncA11y` only creates/updates, it never
prunes", which is true of that method but reads as though removal never happens
automatically. It now explains that the following order pass does prune, and that
`detachA11y` is for the case that pass cannot see — a child dropped from a
component's own bookkeeping while still parented, or discarded before the next
sync.

No behaviour change.
