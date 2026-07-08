---
'@vectojs/core': patch
---

Fix `Entity.add()` not detaching a child from its previous parent: adding the same child to a parent twice duplicated it in `children[]` (a single `remove()` call only strips the first occurrence, leaving a stale entry that keeps rendering/updating despite `child.parent` reporting `null`); re-parenting to a different entity without an explicit `remove()` first left the old parent holding a stale reference whose own `.parent` disagreed with where the child now actually lived. `add()` now detaches from any existing parent first — the same convention Three.js's and PixiJS's `add`/`addChild` already follow. The check is O(1) for the common case of adding a brand-new entity.
