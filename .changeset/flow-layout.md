---
'@vecto-ui/ui': minor
---

feat(ui): add Flow layout component and Stack wrap support

- `Stack` now accepts `wrap`, `maxWidth`, and `maxHeight` options. When
  `wrap: true`, children overflow onto the next line when the main-axis
  extent exceeds the limit — producing a CSS flexbox-like flow layout.
  Existing non-wrapping Stacks are unaffected (backward compatible).
- Added `Flow` convenience component: a `Stack` pre-configured with
  `direction: 'horizontal'` and `wrap: true` — the most common use case
  for responsive tag/chip/card layouts.
