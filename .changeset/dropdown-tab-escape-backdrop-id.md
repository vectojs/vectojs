---
'@vectojs/ui': patch
---

Close Dropdown menus on Tab; Escape anywhere; unique backdrop ids (#693)

Tab now closes an open menu and keeps its native default (ARIA combobox
behavior) instead of moving focus out and stranding keyboard users on a menu
the entity-level handler could no longer see. While the menu is open, a
document-level capture listener (same pattern as Modal's trap) closes it on
Escape regardless of where focus sits, and is torn down in `closeMenu` and
`destroy`. Backdrops are now id'd from the dropdown instance
(`${id}-backdrop`) so two open menus no longer collide in the projection.
