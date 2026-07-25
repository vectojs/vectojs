---
"@vectojs/core": patch
"@vectojs/ui": patch
---

Fix two interaction bugs found by verifying the suspected input/a11y list (three
of the listed items turned out to need no change):

- **Hover was never cleared when an entity was removed mid-hover**
  (`@vectojs/core`). Hover is driven by the projected shadow element's
  `mouseenter`/`mouseleave`; detaching that element fires no `mouseleave`, so an
  entity removed while the pointer was over it kept `hovered = true` forever —
  visible the moment it is re-added (a pooled virtualized row, a reopened menu) as
  hover styling with no pointer anywhere near it. Removal now synthesizes the
  `pointerleave`, including for hovered descendants of a removed subtree, and
  emits nothing when the entity wasn't hovered or had already left.
- **IME composition over a selection painted a stale highlight**
  (`@vectojs/ui`). Composing over selected text logically replaces that range, but
  the native `<input>`/`<textarea>` keeps reporting the pre-composition
  `selectionStart`/`selectionEnd` until commit — so `Input` and `TextArea` drew the
  old selection behind (and wider than) the composition underline. The selection
  highlight is now suppressed while a non-empty composition is active.
- **`TextArea` never drew a composition underline at all** (`@vectojs/ui`). It
  tracked `composition` but never used it, leaving a multi-keystroke IME
  conversion with no in-canvas feedback. It now underlines the composing range,
  per line so a wrapped composition is marked on every line it covers.
