---
'@vectojs/ui': patch
---

`RadioGroup` now handles Home and End.

Arrow keys already moved within the group, but Home/End did nothing — focus stayed
put. The ARIA radiogroup pattern requires both, and `Tabs` already implemented
them, so the group was the odd one out.

Home selects the first enabled option and End the last, scanning inward so a
disabled option at either edge does not swallow the key. Landing on a disabled
radio would be worse than not moving.
