---
"@vectojs/ui": patch
---

Project an inline object's `alt` into the content projection instead of the raw
U+FFFC sentinel, so copying text containing inline math yields the formula.

`RichText.getContentProjection()` built its text from `sourceText()`, which carries
one literal U+FFFC per inline object because that is the string
`LayoutNode.sourceIndex` indexes. The sentinel therefore reached the DOM mirror
verbatim: a real browser `Range` copy of a paragraph with inline math yielded
`'Iota \ufffc kappa.'` — an invisible character on the clipboard — while
`getA11yAttributes()` was already returning the correct `'Iota E = mc^2 kappa.'`.
Screen readers were fine; anyone selecting the text was not.

This could not be fixed by swapping `sourceText()` for the existing
`accessibleText()` at the top of `getContentProjection()`. Layout offsets index
`sourceText()`, where an object is exactly one character, so an `alt` of any other
length shifts every later offset and the per-line slices would desynchronise from
the laid-out glyphs — the selection boxes would drift off the drawn text.

Instead, a new `projectedSlice(start, end)` takes an interval in **source**
coordinates and substitutes each object's `alt` only on the way out. Every offset
stays in the coordinate space layout uses; only the emitted strings change. All four
emission points now route through it — the projection `text`, each line's `text`,
each line's `separatorAfter`, and the per-run text in both the natural-flow
(`logicalRuns`) and justified (`positionedRuns`) paths. Substituting in only some of
them would leave `projection.text` disagreeing with what the DOM assembles, which
`Scene`'s dev-mode projection-mismatch check warns about and which
`preserveContentSelectionAcrossRebuild` relies on when it snapshots caret offsets.

An object with no `alt` contributes nothing, matching `accessibleText()`: an
unlabelled decorative object is better absent from a copy than present as an
invisible character. A paragraph whose only content is such an object still returns
a projection rather than `null`, because emptiness is decided on the source — it
occupies layout, and returning `null` would make `Scene` release and recreate the
DOM node.

Verified in both engines by a real `Range` copy, added as a fourth gate to
`packages/markdown/e2e/selection-fidelity.e2e.ts` (its fixture document gains an
inline-math paragraph). The gate asserts the copied text, that select-all carries the
alt too, and that the copy and the accessible name now **agree** — a projection that
regressed one but not the other is the exact shape of the original defect. Confirmed
to fail pre-fix, with the DOM mirror reading `Iota \ufffc kappa.`. 13 new jsdom unit
tests cover the multi-character, newline-bearing, absent, leading, trailing, and
two-object cases.
