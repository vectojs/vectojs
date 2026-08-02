---
"@vectojs/layout": minor
---

Add `TextStyle.lineThrough` so a text run can be struck through.

Rendering-only: glyph advances are unchanged, so a struck run measures and wraps
exactly as it would without the line. This is distinct from the underline a
hyperlink gets, which is implied by `TextStyle.href` rather than requested — a
struck run is a semantic state of the content (GFM `~~deleted~~`), so it has to be
expressible independently of any destination, including on a run that is both.

`@vectojs/ui`'s `RichText` paints it.
