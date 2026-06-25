---
'@vecto-ui/core': minor
---

Add rendering-performance controls to `Scene` and `Entity`.

- Viewport culling: `Entity.getBounds()` (default `null` = never culled) lets the
  render loop skip off-screen entities. Lifts large/scrolled scenes (e.g. 10k
  mostly off-screen entities) back to 60fps.
- On-demand redraw: `Scene.renderMode = 'onDemand'` + `markDirty()` make static /
  event-driven UIs idle at ~0 cost regardless of entity count.
- Accessibility early-out: `Scene.syncA11y` is skipped when no interactive
  entities are present.
- The render loop propagates the world transform as scalar params (zero per-node
  allocation).
