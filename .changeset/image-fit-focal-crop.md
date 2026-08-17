---
'@vectojs/ui': minor
'@vectojs/core': minor
---

Add `fit` (`'fill' | 'cover' | 'contain'`) and `focalPoint` to `@vectojs/ui`'s `Image`, preserving aspect ratio with focal cropping, and apply `radius` to the loaded bitmap — not just the placeholder. Backed by optional rounded-corner radii on `IRenderer.clip`, implemented for Canvas and SVG so the feature is renderer-consistent.
