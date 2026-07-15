---
'@vectojs/core': minor
---

Add concrete primitive entities and two base-class ergonomics, so common shapes and grouping no longer require a bespoke `Entity` subclass.

- `Rect` — an axis-aligned rectangle primitive (`RectOptions`: `width`/`height`/`fill`/`stroke`/`strokeWidth`/`radius`), drawn from its local origin `(0,0)`. Its `width`/`height` match the drawn box so the a11y shadow node lines up. A plain solid-fill, square-cornered, unstroked `Rect` opts into the WebGL instanced-rect fast path via `getBatchRect`; rounded/stroked rects use the Canvas path.
- `Circle` — a circle primitive centered on its local origin (`CircleOptions`: `radius`/`fill`/`stroke`/`strokeWidth`). Its a11y box is the bounding square offset by `-radius` so it covers the disc. A plain solid-fill (unstroked) `Circle` opts into the point-batch fast path via `getBatchCircle`.
- `Group` — a transform-only container that draws nothing and is transparent to hit-testing (children stay independently interactive), for composing one transform onto a set of children. Accepts children inline: `new Group(a, b, c)`.
- `Entity.set(props)` — assign several own properties in one chained call, each through its normal setter (so configured transitions still animate). Typed `Partial<this>`.
- `Entity.add(...children)` — `add` is now variadic; `parent.add(a, b, c)` attaches all three in order. The single-child call is unchanged.

All additive and backward-compatible; `Entity` remains abstract and existing subclasses are untouched.
