---
'@vectojs/core': patch
'@vectojs/ui': patch
---

fix: pin every grapheme to its canvas prefix so Firefox text selection stops drifting

Selection highlights and caret positions on natural-order canvas text drifted
progressively from the painted glyphs in Firefox. This is the residual left over
by the attached-measuring-canvas fix, which named it Bug B: a ~0.3% per-character
advance mismatch that accumulates along a line, measured at 1.50–1.70 px by
mid-line on real Firefox 153.0.

Root cause is Gecko grid-fitting DOM advance widths to integer device pixels for
layout while canvas keeps them fractional. It is not a font-family property and
has no monotonic size threshold — measuring `measureText('MMMMMMMMMM')` against
`getBoundingClientRect().width` at dpr 1.5789, the sign flips with size on the
same family: `12px monospace` is −0.37 px, `15px monospace` is exactly 0,
`22px monospace` is +0.42 px and `24px monospace` is −0.47 px. A family gate or a
size gate would therefore both be unsound, so carriers are emitted unconditionally
for eligible lines; the cost is DOM nodes, never wrongness.

`@vectojs/core` gains a `perGraphemeCarriers` flag on `ContentProjectionLine`.
When set, `Scene` splits the line with `Intl.Segmenter` at grapheme granularity
and emits one flow-relative carrier per cluster instead of a single text node,
reusing the `position: relative` + `display: inline-block` pattern the positioned
runs already use. Each carrier's `width` is the **canvas prefix difference**
(`measureText(text.slice(0, end)) - measureText(text.slice(0, start))`), not the
isolated cluster width: summing per-cluster measurements drops kerning and
ligatures, while prefix differences are exactly what the canvas painted. Setting
`width` forces the DOM to accumulate the same total as the canvas regardless of
how the browser resolves ligatures inside each `inline-block`. Without a document
the line falls back to a single text node, so SSR is unchanged.

`@vectojs/ui` `Text` sets the flag only when the line is neither bidi nor
justified. Bidi is excluded because DOM order is logical while `x` is visual, so
per-glyph carriers break caret hit-mapping — the regression that forced the PR #146
revert — and `line.x !== 0` is not a usable discriminant since
`bidiLineOriginX()` legitimately returns 0 for a left-aligned RTL line. Justified
lines already carry positioned runs and take the existing path. An explicit flag
is used rather than inferring eligibility in `Scene` because `RichText` always
emits `runs` and never reaches the same branch, so no inferred signal separates
the two producers.

Mid-line drift on the same fixture falls from 1.50–1.70 px to a maximum of
0.023 px on Firefox 153.0 at dpr 1.5789. Forcing the flag off restores the drift,
confirming the carriers are what corrects it. Covered by four new `Scene` unit
tests — flag on, flag off, multi-codepoint clusters, and prefix-accurate
positioning — and by the existing e2e matrix, where the ligature width-parity case
is what caught the isolated-measurement mistake.
