---
'@vectojs/ui': patch
---

Stop projecting `aria-setsize` on the `VirtualList` container.

`aria-setsize` is defined on set **members**, not on the set itself, so putting it
on the `role="list"` container is a disallowed attribute — axe reports it as a
critical `aria-allowed-attr` violation. The count already reaches assistive
technology through the container's accessible name, and per-row `posInSet`/`setSize`
carry the position, which is what actually prevents a virtualized list being
announced as "item 3 of 12".

Introduced one release earlier alongside the new attributes, and caught by the axe
suite when a virtualized list was added to the conformance fixture.
