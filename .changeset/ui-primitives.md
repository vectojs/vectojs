---
'@vecto-ui/ui': minor
---

Add six new component primitives, completing the layout/display and form-control set.

- **Layout/display**: `Image` (`<img alt>` shadow node, placeholder until load),
  `Card` (rounded panel + optional border, optional `role="group"`), `Stack`
  (vertical/horizontal auto-layout with gap + cross-axis align).
- **Form controls** (real shadow nodes, agent-/AT-operable by role): `Input`
  (`<input>` textbox, value flows back via the `change` event), `Checkbox`
  (`<input type=checkbox>`), `Toggle` (`role="switch"` with `aria-checked`).
- Exposes `fontSizePx(font)` and fixes a sizing bug: component height now parses
  the `px` token from a CSS font shorthand instead of `parseFloat`, which wrongly
  returned the _weight_ for fonts like `'600 16px sans-serif'` (made buttons/links
  hundreds of px tall).
