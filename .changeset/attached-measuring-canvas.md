---
"@vectojs/ui": patch
---

Measure text on an attached canvas so Firefox advances match the painted glyphs.

`RichText.baseMeasurer` and `measure.ts`'s shared context both created a canvas
and never appended it, while the engine paints on the page's real attached
canvas. Firefox resolves a generic CSS family (`monospace`, `sans-serif`)
through a per-language font preference that is only reachable from a document
style context, so the detached measurer fell back to a hardcoded 0.5em advance:
it advanced every run 20% short of the glyphs actually drawn, and the following
run landed on the tail of the previous one. The reported symptom was inline code
overlapping the CJK text after it.

Measured in a real `lang="zh"` document with the default code font, run
`TextArea` followed by CJK, painted ink as ground truth (advance 76.8, last
inked pixel x = 75):

| engine   | detached (before) | attached (after) | overlap before → after |
| -------- | ----------------- | ---------------- | ---------------------- |
| Firefox  | 64.0              | 76.8             | **12.8px (16.7%) → 0** |
| Chromium | 76.8              | 76.8             | 0 → 0                  |

Both sites now go through a shared `createMeasuringContext()`, which appends a
hidden 1×1 `aria-hidden` canvas. The invariant is _measure where you paint_
rather than "get 76.8": in a document with no `<html lang>` Firefox genuinely
paints at the 0.5em fallback, and the helper correctly reports 64 there too. The
helper agreed with the real rendering canvas in all six engine × document
combinations tested, where a detached context disagrees in Firefox whenever a
`lang` is present. This also corrects `TextArea`'s wrap measurement, which used
the same shared context.

Chromium was self-consistent and is unaffected.
