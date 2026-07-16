---
'@vectojs/graph3d': patch
---

Make GraphInteraction robust to pointer events that start or end off-canvas:

- A pointer release whose press never touched the canvas no longer fires
  `onSelect(null)` — clicking unrelated UI elsewhere on the page no longer
  deselects the current node.
- `pointercancel` (touch scroll takeover, pen out of range) now ends an active
  drag, re-enables the host's controls, and fires `onDragEnd`; previously the
  drag stayed stuck and controls stayed disabled because a cancelled pointer
  never delivers `pointerup`.
- Drags capture the pointer so the node keeps tracking while the cursor is
  outside the canvas.
- `dragReheat: 0` now skips the `reheat` call entirely, as documented.
- `D3ForceLayout.setGraph` honors `x`/`y`/`z` initial position seeds on nodes
  (in addition to `fx`/`fy`/`fz` pins), so pre-seeded graphs start
  deterministically.
