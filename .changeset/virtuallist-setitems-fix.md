---
"@vectojs/ui": patch
---

fix(ui): VirtualList.setItems clears stale pooled rows in unkeyed mode

The unkeyed branch of `setItems` reset scroll and cleared the height cache but never cleared `_pool`. `_reconcile` then reused pooled entities for any index still in the visible range without calling `renderItem` again, so every overlapping index kept rendering the OLD item's content. The docstring explicitly promises a clean replace; only the height cache was actually cleared. The keyed path was already correct (rekey maintains key↔entity identity).

The fix removes all pooled entities and clears `_pool` before `_reconcile` in the unkeyed branch, forcing fresh remounts for the new items.
