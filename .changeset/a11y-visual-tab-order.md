---
"@vectojs/core": minor
---

Accessibility tab / screen-reader order now follows the **visual reading
order** instead of scene-graph insertion order. `enforceA11yDomOrder` sorts the
projected a11y mirrors into rows top-to-bottom and then inline within each row,
so two entities added in any order but drawn side by side Tab left→right. A new
`readingDirection: 'ltr' | 'rtl'` scene option (and `Scene.readingDirection`
setter) reverses the inline order for right-to-left UIs. Entities at the same
position keep their insertion order as a stable tiebreak.
