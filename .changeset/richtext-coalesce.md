---
'@vectojs/ui': patch
---

Coalesce adjacent same-style glyphs into one `fillText`.

`RichText.render` issued one `fillText` **per character**. Measured on a Markdown
streaming workload, that was 369,324 calls over 400 appends — and `fillText`
accounted for 71-84% of all entity painting, which itself was 92-99% of render.
Shaping was not the problem: `measureText` was 0-5.7%.

Runs of adjacent glyphs sharing font and colour are now drawn in a single call:

| shape | `fillText` calls | render (Chrome) | render (Firefox) |
| --- | --- | --- | --- |
| prose | 369,324 → 176,112 | 382 → 226ms (1.69x) | 346 → 228ms (1.52x) |
| mixed | 142,728 → 30,798 | 142 → 61ms (2.33x) | 144 → 58ms (2.50x) |

A run is only coalesced when its measured width equals the summed per-glyph
advances. Layout positions each character from an isolated `measureText(char)`, so
drawing them as one string would let the browser apply kerning and ligatures and move
glyphs away from where layout put them — visible as text drifting from its selection
overlay and hit box. The check costs one memoized `measureText` per run against what
was one `fillText` per character.

Whitespace, links and any positional gap (justification, tabs, bidi reordering) end a
run, so those paths are unchanged.

`CodeBlock` is unaffected — it self-draws a character grid rather than using
`RichText`, so a code-heavy stream sees no change (247,380 calls before and after).
