---
"@vectojs/layout": minor
---

Right-align RTL paragraphs. The layout engine packed glyphs from the left and reordered within bidi runs, but never aligned the line as a whole — so Arabic/Hebrew paragraphs sat flush-left instead of flush-right (confirmed identical on real Chrome and Firefox, since canvas layout is engine-driven). `commitLine` now computes a whole-line shift when the paragraph base level is RTL and a finite wrap width is set, so each visual line ends flush at the wrap edge, per line, independently. LTR text, justified text, unbounded-width text, and exclusion-flow lines are unchanged (the last is left for a dedicated follow-up).
