---
'@vectojs/core': patch
---

Fix pointer capture being stolen by projected container mirrors.

The a11y projection wires a `pointerdown` listener on every mirror element that
calls `setPointerCapture` unconditionally. A real click dispatches natively on
the deepest hit-testable mirror and bubbles through every projected ancestor,
so each ancestor's listener overrode the child's own pending capture. Per spec
the pending target applies before the next pointer event dispatch, so
`pointerup` retargeted to the ancestor and the resulting `click` fired on their
common ancestor — the container, which usually has no click handler. Nested
interactive controls inside a projected container silently stopped working;
measured live as `Dropdown` menu options whose clicks landed on the listbox
container, leaving the menu open with nothing selected.

`pointer-events: none` on the container does not prevent this — pe only gates
hit-testing, the bubbled event still crosses the element and fires its
listener. The guard is at the source instead: a mirror captures only when it is
the native target of the gesture (`e.target === el`). Bubbled events no longer
re-capture; direct hits behave exactly as before.
