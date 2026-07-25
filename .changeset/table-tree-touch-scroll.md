---
"@vectojs/ui": minor
---

Add touch / pointer **drag-to-scroll** to `Table` and `TreeView`, matching
`VirtualList` and `ScrollView`. A virtualized `Table` previously only scrolled
with a mouse wheel, and `TreeView` toggled a row on `pointerdown` — both were
effectively unusable on a touchscreen. Now:

- `Table` body follows the finger 1:1 (`pointerdown`/`move`/`up`), same sign
  convention as its wheel scroll.
- `TreeView` drag-scrolls and defers the expand/collapse toggle to `pointerup`,
  firing it only when the pointer moved less than a small tap threshold — so a
  drag scrolls without accidentally toggling the row it started on, while a tap
  still toggles as before.
