---
'@vectojs/core': patch
---

Fix `getWorldTransform()`/`getWorldScale()`/`getWorldRotation()` silently dropping every transform above an ancestor whose `id` happened to equal the string `'root'`. Scene's own root entity is internally named that, but `id` is a plain user-settable string with no reservation — any caller who names their own top-level container `"root"` (an entirely ordinary choice) would have any entity nested under it lose its parent's position/scale/rotation contribution entirely. Now walks to the true top of the tree (`.parent === null`) instead of matching on `id`.
