---
"@vectojs/core": patch
---

Cover the `TreeView` / `ContextMenu` per-child a11y hotspots in the real-browser
e2e. Their `role="treeitem"` / `role="menuitem"` projection, roving tabindex, and
`aria-haspopup` had only ever been asserted in jsdom, and — more importantly —
so had the `pointerEvents: 'none'` contract that keeps them from stealing the
mouse from the component underneath (tap-to-toggle, drag-to-scroll). That is the
same class of regression CI already caught once for `Table` cells, so it now runs
in both Chrome and Firefox against `elementFromPoint`.

The fixture adds the menu but deliberately leaves it **closed**: showing a
`ContextMenu` installs a full-scene interactive backdrop to catch the outside
click, which intercepts every pointer drag and broke four unrelated selection
assertions. The probe opens it, measures, and closes it again.

Also fixes each benchmark `serve.ts` logging a hardcoded `http://127.0.0.1:8178`
regardless of the `PORT` it actually bound — a mismatch that misleads debugging.
