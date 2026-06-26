---
'@vecto-ui/core': minor
---

Curve-accurate hit-testing for `SplineEntity`, and a new `Entity.getWorldScale()`.

- `SplineEntity` now picks against the actual curves by default: a point hits
  only within `lineWidth/2 + hitTolerance` of a flattened Bézier (cached), instead
  of anywhere in the bounding box. Options: `hitTest: 'curve' | 'aabb'` (default
  `'curve'`) and `hitTolerance` (extra local-unit pick padding).
- Fixes a scale bug: `isPointInside` now maps the world point into the entity's
  unscaled local space via the new `Entity.getWorldScale()`, so hit-testing is
  correct for scaled/nested splines (previously the click area didn't track the
  visual size under scale).

Note: `'curve'` is the new default, so clicks between strokes inside the bounding
box no longer register — pass `hitTest: 'aabb'` for the old behavior.
