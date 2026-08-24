---
'@vectojs/ui': patch
---

Reset Tree scroll offset in setNodes (#688)

`setNodes` cleared nodes/expansion/selection but never reset or clamped the
scroll offset. With the old offset past the new content height, `update()`
settled onto the stale target, `_visibleRange()` returned `start > end`, and
`_syncHotspots()` shrank its pool toward a negative count — leaving a blank,
untappable control with zero tab stops until a wheel or drag event arrived
(touch users had no recovery path). `setNodes` now clamps and syncs the
offset, and drops the stale active-id highlight.
