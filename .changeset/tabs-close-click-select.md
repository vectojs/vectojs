---
'@vectojs/ui': patch
---

Stop Tabs close click from also selecting the tab (#687)

One physical click on × delivered two events: the bubbled pointerdown that
runs `onClose`, then the hotspot mirror's own DOM click which selected the
tab. With a synchronous removal the mirror detaches first and hid the defect;
any deferred close left it alive, so the dying tab became selected and later
removal blanked the panel. The close pointerdown now arms a latch that the
hotspot click consumes instead of selecting; every fresh pointerdown re-arms
from scratch.
