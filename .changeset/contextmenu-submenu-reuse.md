---
'@vectojs/ui': patch
---

Fix `ContextMenu` showing the wrong submenu content: the submenu instance was lazily created once and reused for every item with `children`, tracked by a single `_submenu` field with no record of _which_ item it represented. Opening a second submenu item just repositioned the first item's still-showing submenu instead of building one for the newly-clicked item. The submenu is now rebuilt whenever a different item is opened.
