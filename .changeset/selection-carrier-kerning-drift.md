---
'@vectojs/core': patch
'@vectojs/ui': patch
---

fix selection carriers drifting from painted glyphs by the accumulated kerning delta

The layout engine positions every glyph by summing isolated per-grapheme
advances (no kerning), and the canvas paint is guaranteed to stay within
0.5px of those positions. But the DOM selection carriers measured _shaped_
text — `RichText.logicalRuns` pinned run widths to whole-string
`measureText`, and Scene's per-grapheme carrier path measured shaped prefix
differences of the whole line — so carriers included kerning the canvas
never painted. On kerning-heavy Latin text this drifted the native selection
box up to 5-8px across a ~300px line in both Gecko and Blink, per word and
style dependent.

The carrier measurement now follows the line's paint model, declared by a
new `ContentProjectionLine.shapedPaint` flag:

- Per-glyph painters (`RichText`, core `TextEntity` — ink at unkerned layout
  positions) get isolated grapheme advances: Scene's per-grapheme carriers
  measure each grapheme segment in isolation (no prefix subtraction, no left
  correction), and `logicalRuns` sums per-grapheme advances instead of
  shaped run widths.
- Shaped painters (`ui/Text`'s fast one-`fillText`-per-line path — ink
  includes browser kerning and ligatures) declare `shapedPaint: true` and
  keep shaped prefix-difference carriers, which accumulate to exactly the
  painted extent (verified by the ligature DOM/Canvas width e2e).
