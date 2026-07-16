---
'@vectojs/ui': patch
---

Fix duplicate-instance entity id collisions and wrong-tab closes:

- Eleven components (Overlay, Tabs, RadioGroup, ProgressBar, ScrollView,
  PanelResizeHandle, Panel, PanelGroup, TreeView, VirtualList, Stack) passed
  their class name to `Entity(id)` as the entity id, so every instance in a
  scene shared one id. The accessibility projection keys its shadow-element
  map by id, so duplicate instances shared a single DOM element and pointer
  events routed to whichever entity claimed the id first — e.g. with two
  nested PanelGroups, dragging the inner split divider resized the outer one.
  Instances now receive unique generated ids (devtools type labels come from
  the constructor name and are unaffected).
- `Tabs` no longer stretches tabs to fill surplus bar width: a stretched tab's
  right-edge × rendered directly beside the next tab's label, and users
  closed the wrong tab. `tabWidth` is now the maximum; extra strip width
  stays empty.
