---
'@vectojs/ui': patch
---

Fix `ContextMenu` staying open with no way to dismiss it, and its keyboard-shortcut hint overflowing the panel's right edge.

- `showAtPoint` now mounts a full-screen invisible backdrop behind the menu while it's open; clicking anywhere outside the menu (or a nested submenu) closes it, matching every native context menu. Previously the only way to close it was clicking one of its own non-disabled items.
- The `shortcut` hint (e.g. `Ctrl+C`) is now measured and its draw position offset so its right edge lands at the panel's inset, instead of always starting at `width - 12` and running rightward past the border for anything longer than a couple of characters.
