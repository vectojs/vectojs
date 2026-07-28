---
'@vectojs/devtools': minor
---

Add a text inspector, the first consumer of the plugin protocol.

`inspectText(entity)` reports what VectoJS's own shaping knows and a DOM inspector
cannot: the UAX #9 base direction, per-character bidi levels collapsed into level
runs, the L2 reversal segments the algorithm actually performs, the visual order
permutation, grapheme clusters, and per-glyph visual x, advance and level read
from a prepared content grid or prepared text. `shapeProbe(text)` runs an
arbitrary string through the real pipeline, so a bidi or cluster question can be
settled without editing the app.

`auditTextShaping(scene)` reports entities with glyphs absent from the atlas,
naming the offending characters — those are the ones paying for a canvas
`measureText` per glyph.

Four of the nine capabilities originally asked for are reported as unavailable
with a reason rather than approximated, since a debug tool that invents a
plausible number is worse than one that admits ignorance. Glyph ids do not exist
in this engine at all — the atlas is keyed by codepoint. No script itemizer
exists, only a whole-string boolean. No API names the font actually used for a
run, so per-glyph atlas misses are reported instead. Prepared text carries
advances but not placed positions, and `LayoutResult` has no line index.
