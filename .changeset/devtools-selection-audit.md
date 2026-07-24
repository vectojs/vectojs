---
'@vectojs/devtools': minor
---

Add a selection-overlap audit: `auditSceneSelection(scene, opts)` / `auditEntitySelection(scene, entity, opts)` report where a selectable text entity's transparent DOM content projection (what the browser lets users drag-select and copy) drifts from the glyphs the canvas actually drew. It compares live `Range.getClientRects()` against the entity's own `ContentProjection` line geometry, mapped into local logical px so the check is DPR/zoom-independent — catching the justify (widened gaps), RTL/bidi (visual reorder), and fractional-scale rounding failure modes. Empty result = every selection box tracks its glyphs, so it doubles as a QA gate when driven on a real browser (see `scripts/selection-harness`).
