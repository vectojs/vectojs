---
'@vectojs/core': minor
'@vectojs/ui': minor
---

RTL / bidi text selection now overlaps the drawn glyphs. The engine right-aligns and visually reorders RTL lines, but the DOM content projection previously anchored every line at x=0, so the native selection box drifted off the glyphs (measured 300px+ on real Chrome). `Text` now anchors a bidi line's projection at its **visual origin** (the line's min glyph x) while keeping it a single natural-flow string in **logical** source order — so the browser's own bidi gives correct caret hit-mapping AND the selection rectangles overlap the canvas glyphs. RTL canvas text also renders glyph-by-glyph so it can actually right-align. Verified on real Chrome 150 + Firefox 153 across DPR 1/1.5, 90% zoom, and font-substitution cases. Left-aligned LTR text is unchanged.
