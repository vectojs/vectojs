---
'@vecto-ui/core': minor
---

feat(core): make SplineEntity interactive by default and add showBounds

- SplineEntity now sets `interactive = true` in its constructor so the
  a11y shadow layer creates a shadow DOM node and dispatches pointer
  events (click, pointerdown, hover, pointerleave) through the entity
  tree. Previously consumers had to manually set this.
- Added `showBounds: boolean` property (defaults to `false`). When
  toggled on, `render()` draws a rounded-rect outline of the entity's
  local bounding box — useful for drag feedback and debugging hit areas.
  The outline follows the entity's transform (rotation, scale) naturally
  since it is drawn in local space.
