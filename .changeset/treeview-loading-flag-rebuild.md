---
'@vectojs/ui': patch
---

Fix `TreeView`'s lazy-load spinner disappearing prematurely: the `loading` flag was mutated directly on the `FlatRow` object captured before the `await`, but a sibling lazy node resolving in the meantime calls `_buildRows()`, which replaces `this._rows` with entirely fresh row objects (always defaulting `loading: false`). The original row's later `loading = false` then mutated a detached, no-longer-rendered object — leaving the still-pending node's row showing no spinner and no children until its own load finished. `loading` is now tracked in a `Set<string>` on the TreeView itself and read by `_buildRows()`, so it survives rebuilds triggered by other in-flight loads.
