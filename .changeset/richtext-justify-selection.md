---
'@vectojs/ui': minor
---

RichText justified selection now overlaps the drawn glyphs. On a justified line the engine widens inter-word gaps on the canvas, but the DOM content projection used natural-flow style runs, so the native selection box drifted off the widened words (real-hardware verified). RichText now projects a justified line as per-glyph positioned carriers — each at its own visual x, in logical source order (correct copy / screen-reader order), carrying the logical source substring (not the shaped glyph). Ragged (left-aligned) lines keep the cheaper natural-flow style runs, and per-run bold/italic/size fonts are preserved on both paths.
