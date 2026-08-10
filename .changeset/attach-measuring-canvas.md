---
'@vectojs/text': minor
'@vectojs/layout': patch
'@vectojs/ui': patch
---

fix: attach measuring canvas to document so Firefox resolves generic font families correctly

A detached `document.createElement('canvas')` used for `measureText` in
`@vectojs/text`, `@vectojs/layout`, and `@vectojs/ui` caused Firefox to
resolve generic CSS families (`monospace`, `serif`, `sans-serif`) to a
different font than the one actually painted on the scene canvas. The
discrepancy reached 17–47% on `monospace` and `serif` with a CJK document
language (`<html lang="zh">`), producing misaligned text selection highlights
and wrong line breaks.

Root cause: Gecko looks up the generic-to-real font mapping through a
per-language preference that is only reachable from a live document style
context. A canvas outside any document falls back to a hardcoded 0.5 em
advance. The same canvas `append → measure → remove` cycle confirmed the
resolution is dynamic, not latched at creation.

Fix: `@vectojs/text` now exports `getSharedMeasuringContext()` from a new
`measureContext` module. It creates a 1×1 `position:absolute;opacity:0`
canvas appended to `document.body` and memoizes it — the canonical
"measure where you paint" helper. `Typography.ts` (baseline computation),
`@vectojs/layout`'s `createCanvasMeasurer` (line-breaking advances), and
`@vectojs/ui`'s `Text` and `measure` module all converge on this one
attached context. The old per-call `createElement` paths are removed.

Chromium is unaffected (generic families resolve identically attached or
detached), so this is a Firefox-only correctness fix.

Residual: a ~0.3% per-character advance mismatch between the attached canvas
and DOM layout remains in Gecko (device-pixel grid-fitting). This is a
separate platform-level issue tracked as Bug B.
