---
'@vectojs/core': patch
'@vectojs/ui': patch
---

Add an axe-core audit of the projected accessibility layer, and fix the three
violations it found.

VectoJS projects a real DOM shadow tree for semantics, so standard a11y tooling
applies to that layer — and running it found bugs the hand-written conformance
assertions could not, because those check what we thought to check.

Fixed:

- **`aria-valuenow` was emitted for every non-input element**, so a `combobox`
  reported `aria-valuenow="Small"` — a text value on a numeric attribute that is
  not allowed on that role, which axe flags as two separate critical violations.
  It is now restricted to the range roles it is defined for (`slider`,
  `spinbutton`, `progressbar`, `scrollbar`, `meter`).
- **`Modal` had no accessible name.** Its title was drawn on canvas and never
  projected, so a screen reader announced a bare "dialog" with no indication of
  what it was for.

Rules that cannot apply to a canvas runtime are disabled **with a stated reason**
rather than silently ignored — notably colour contrast (the projected nodes are
transparent; the visible pixels are canvas-drawn) and the two DOM-containment rules
that a flat projection cannot satisfy.
