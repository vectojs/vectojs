---
'@vectojs/devtools': minor
---

Add an accessibility inspector and audits.

`inspectA11y()` reports the accessible name and where it came from, tabIndex,
disabled, focused, flat reading-order position, and DOM bounds alongside canvas
bounds — the divergence unique to a zero-DOM UI, where the canvas can look correct
while the projected tree is wrong.

`auditA11y()` covers five failure classes already observed in this codebase:
`no-accessible-name`, `role-tag-conflict`, `disabled-divergence`,
`focusable-but-clipped`, `duplicate-label`. `a11yReadingOrder()` lists the
projected nodes in traversal order.

The panel gains an A11y tab showing the selected entity's readout followed by the
scene-wide findings, with findings belonging to the selection marked.
