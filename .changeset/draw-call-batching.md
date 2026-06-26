---
'@vecto-ui/core': minor
---

Add opt-in draw-call batching for point-cloud / particle entities.

- `IRenderer.fillCircle(cx, cy, radius, color, alpha?)` + `flush()`: an
  order-preserving batch that coalesces consecutive same-color circles into a
  single `beginPath` + N `arc` + one `fill()`. Capped at `MAX_BATCH` (64) so a
  single Canvas 2D `fill()` never grows large enough to hit its superlinear
  multi-subpath cost.
- `Entity.getBatchCircle()` (default `null`): a leaf entity that draws as a
  uniform-scaled filled circle returns `{ radius, color }` to opt in.
- `Scene` draws such leaves through the batch, skipping their per-entity
  `save`/`translate`/`scale`/`rotate`/`restore` and `render()`, flushing per
  sibling group so painter's order is preserved.

Measured: ~34% faster at 10k circles (60→91 fps), neutral at 1k and at 100k
(no regression). Default entities are unaffected.
