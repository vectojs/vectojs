---
"@vectojs/core": patch
---

Fix native selection and Tab order across composite widgets. `Scene`'s
projection-ordering pass read each mirror's raw `style.top`/`style.left`, but a
mirror nested inside a container (a `gridcell` inside a `row`) carries
**parent-relative** coordinates by design while a flat one carries world
coordinates, so the two were compared as if in one space and every nested mirror
sorted as though it sat at the top of the document. A container mirror also
extended the visual row band across every row it owned, collapsing a whole table
into a single band.

Together these ordered a table's cells column-major: selecting a two-column
table returned the entire first column and then the entire second, in both Chrome
and Firefox, and the same order drives Tab navigation. Positions are now resolved
by accumulating ancestor offsets, and a container contributes its position to the
sort without extending a row band.

The ordering pass also no longer drops keyboard focus when it moves a focused
mirror. `Dropdown` implements Escape-to-close with an entity `keydown` listener,
which silently stopped firing whenever opening the popup reordered the mirror
holding focus.
