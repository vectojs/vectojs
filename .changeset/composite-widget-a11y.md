---
"@vectojs/ui": minor
---

Add per-child ARIA roles + keyboard navigation to `TreeView`, `Table`, and
`ContextMenu` (WCAG 2.1.1 / 4.1.2), completing the composite-widget a11y work
started for RadioGroup/Tabs in PR #160. Each now projects transparent focusable
hotspots over its canvas-drawn children so a screen reader and keyboard user can
operate them:

- **TreeView** — one `role="treeitem"` per visible row (virtualization-aware
  pool) with `aria-level`, `aria-expanded` (parents), `aria-selected`, and a
  roving tabindex. Keyboard: Up/Down move, Right expands / steps into children,
  Left collapses / steps to parent, Home/End, Enter/Space activate; the active
  row scrolls into view and takes focus.
- **Table** — a real `grid > row > gridcell/columnheader` structure (pinned
  header row + one body `role="row"` per visible row, virtualization-aware),
  each cell a focusable hotspot with a roving tabindex. Keyboard: 2D arrows
  (clamped), Home/End (row extremes), Ctrl+Home/Ctrl+End (grid corners); the
  target cell scrolls into view and takes focus.
- **ContextMenu** — one `role="menuitem"` per non-separator item with
  `aria-haspopup`/`aria-expanded` for submenu parents, `disabled`, and a roving
  tabindex. Keyboard: Up/Down (wrapping, skipping separators + disabled),
  Home/End, Right opens a submenu, Left returns to the parent menu, Enter/Space
  activate, Escape closes.
