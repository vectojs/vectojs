---
'@vectojs/core': minor
'@vectojs/ui': patch
---

Add the `A11yAttributes` fields virtualization actually needs.

Six new optional fields, each added because a component has state it currently
cannot express — not to complete the ARIA surface:

- `posInSet` / `setSize` (`aria-posinset` / `aria-setsize`)
- `rowCount` / `rowIndex` (`aria-rowcount` / `aria-rowindex`)
- `valueText` (`aria-valuetext`)
- `orientation` (`aria-orientation`)

The first four exist for virtualization specifically. A widget that mounts only its
visible window leaves the accessibility tree unable to infer the real totals, so a
list showing rows 40-52 of 10,000 is announced as "item 3 of 12" — the mounted
window's size, not the list's. Stating the totals explicitly is the only fix.

`VirtualList` now projects `setSize` with the real item count. Per-row
`posInSet`/`setSize` belong in the caller's `renderItem`, since those entities are
theirs; the class doc shows the pattern.

All six are omitted when unset rather than emitted empty — `aria-setsize=""` is
invalid, not "no set size".
