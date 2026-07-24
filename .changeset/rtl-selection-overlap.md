---
"@vectojs/core": minor
"@vectojs/ui": minor
---

RTL / bidi text selection now overlaps the drawn glyphs. `Text` detects RTL (bidi) layout and emits per-glyph positioned content-projection runs in **logical** source order (so copy, find-in-page, and screen readers stay correct) while each carrier records its **visual** x — and, critically, the run text is the logical source substring, not the shaped presentation form (Arabic glyphs are U+FExx on canvas but must copy as base letters). Scene now positions carrier runs **absolutely** at their visual x within the line and forces `dir="ltr"` + `unicode-bidi: isolate` on positioned lines, so the browser does not re-bidi-reorder them. Verified on real Chrome 150 + Firefox 153: DOM selection left edges match the canvas glyph x exactly (residual < one glyph advance at range boundaries). Left-aligned LTR text is unchanged (natural single-string flow).
