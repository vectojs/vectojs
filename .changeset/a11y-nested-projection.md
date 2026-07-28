---
"@vectojs/core": minor
"@vectojs/devtools": patch
---

Nest composite widgets in the accessibility projection.

The projection was flat: every mirror was appended to the projection root as a
sibling and reading order came from sorting. That is valid for most of ARIA,
which relates elements by IDREF, but a handful of composite widgets are specified
in terms of ownership — a `gridcell` is only a grid cell because a `row` contains
it. Flat, those widgets were structurally invalid however correct their
attributes were, and axe's `aria-required-children` / `aria-required-parent` had
to be disabled.

The projection now nests exactly the role pairs ARIA requires to be
DOM-contained, derived from axe-core's own role table:
`grid`/`table`/`treegrid` → `row` → `gridcell`, `tablist` → `tab`,
`tree` → `treeitem`, `menu` → `menuitem`, `listbox` → `option`,
`list` → `listitem`. Both rules are now enabled and asserted in CI against
real Chrome and Firefox.

Deliberately narrow. `radiogroup`/`radio` is absent from ARIA's containment
requirements, so `RadioGroup` stays flat, and a role a container may not own is
never nested under it — axe checks unallowed children before it reviews empty
containers, so nesting one would convert a passing tree into a violation.

Rendered geometry is unchanged. A nested mirror's `left`/`top` resolve against
its container rather than the projection root, so those values are now rebased
through the inverse of the container's transform; every element's
`getBoundingClientRect` is identical to the flat projection's, including under a
rotated and scaled ancestor.

`Scene` also sets `data-vecto-a11y-root` on the projection root, so an audit can
scope to the projected layer instead of the whole document.

`@vectojs/devtools`: `a11yInspect`'s `readingOrder` is now the node's position in
document order across the whole projected layer. It was the node's index among
its siblings, which under nesting restarts at 1 inside every row and stops being
comparable between widgets.
