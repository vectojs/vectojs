---
'@vectojs/text': patch
'@vectojs/layout': patch
'@vectojs/animation': patch
'@vectojs/devtools': patch
---

P3 fixes from the 2026-08-13 review (#495, #496):

- `MSDFFont.layout` no longer replaces the kerning base with a combining mark: `prevCode` stays on the base glyph, so a kern pair like A→B still applies across `A\u0301B` instead of being silently dropped.
- `createCanvasMeasurer.measure()` honors the `GlyphMeasurer` contract for per-run `fontFamily`/`bold`/`italic` overrides — it now measures (and caches) at the requested style instead of always returning base-font numbers, so inline `monospace`/bold runs break lines by their own metrics.
- `LayoutEngine.layoutPreparedIntoBuffer` honors `preserveLeadingSpaces` like the allocating path; the zero-GC path previously skipped leading whitespace unconditionally.
- `TweenDriver` sanitizes non-finite `duration`/`delay` (NaN config no longer wedges the value at NaN with `isDone()` forever false) and snaps to `to` exactly when complete, so a custom `EasingFn` with f(1) !== 1 can no longer finish off-target.
- `SpringDriver` drops non-finite or non-positive spring config instead of feeding it to the integrator — `mass: 0` produced NaN velocity and a spring that could never reach rest.
- DevTools: `selectFinding` resolves plugin audit rows to their entities (the unified row list the tree already showed); the transient "owned by parent" warning is inserted at the top of the inspect readout instead of being dropped as row 21 of 20; the full-scene a11y audit is cached across refresh ticks and recomputed on `structureVersion` changes instead of re-walking the tree every 500 ms; the a11y audit, reading-order query, and `inspectA11y` survive a throwing app-supplied `getA11yAttributes()` per entity; and the accessible name / duplicate-label audit uses the full announced string rather than the 80-char display preview, so long labels sharing a prefix no longer collide as false duplicates.
