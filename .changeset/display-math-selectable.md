---
'@vectojs/markdown': minor
---

Render display math as selectable text instead of an `<img>`

`renderDisplayMath()` built `new Image(svgDataUri, { alt: formula })`. An `Image`
reports `getA11yAttributes(): { tag: 'img', src, alt }` and has no
`getContentProjection()`, so a `$$…$$` block contributed nothing to the projected
text layer — not to `innerText`, not to find-in-page, not to a selection, not to a
copy. Inline `$…$` in the very same document did, because it reserves a
`StyledSpan.object` and `RichText` substitutes each object's `alt` for the U+FFFC
sentinel when it projects. A reader with both in one document found one selectable
and the other not.

A display formula is now one inline object in a one-span `RichText`, the same seam
inline math already used, so the TeX source reaches selection, find-in-page, copy
and assistive technology through the existing projection path rather than a second
mechanism. Verified in real Chrome on a 60-line document: zero math `<img>`
elements where there were previously one per visible formula, and
`window.find('\\cos\\theta')` — a display formula — now matches where it could not
before.

Removing the `<img>` also removes the `draggable="true"` that let a formula be
dragged out of the document as an SVG _file_ and dropped back into an app's own
file handler. No reference implementation needs a `draggable="false"` workaround,
because none generates an image; this deletes the vector rather than suppressing
it.

Formulas are now wrapped in an exported `MathBlock` entity carrying the TeX source
and the typeset SVG URI, which is what keeps them addressable for devtools and
tests once the `Image` is gone.
