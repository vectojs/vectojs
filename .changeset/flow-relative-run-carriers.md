---
'@vectojs/core': patch
'@vectojs/ui': patch
---

fix: keep plaintext copy faithful for justified and RTL projected text

Copying selected canvas text out of a justified or RTL paragraph produced
mangled plaintext. Measured on real Chrome, a five-line justified block copied
as 16 newlines instead of 2 and lost every space (0 of 14 survived), so
`The quick brown fox jumps` came back as `The\nquick\nbrown\nfox\njum\nps`.

Two independent causes, both fixed:

`@vectojs/core` positioned each projected run carrier with
`position: absolute`. An absolutely-positioned box is blockified and taken out
of flow, so `innerText` serialization treats every run as its own line. The
carriers are now laid out in flow — `position: relative` +
`display: inline-block`, with `left` set to the delta between the run's target
`x` and the running inline offset accumulated in DOM order. Visual placement is
identical, but the runs remain inline so plaintext serialization joins them on
one line. This is the same mechanism `ContentGridProjector` already used. A line
whose positioned runs do not all carry a `width` falls back to the previous
absolute path.

`@vectojs/ui` `Text.justifiedRuns()` folded each inter-word space into the
preceding word's trailing width, so no carrier contained a space character and
copy concatenated words with nothing between them. Spaces are now emitted as
their own runs, spanning the justify-widened gap. This also fixes a latent
ordering bug the old code masked: a justify-collapsed line-trailing space is
emitted at the last word's own `x`, so sorting runs by `x` spliced it into the
middle of that word (`aa` became `a` + `a`). Runs are now taken in source order,
and a collapsed trailing space is emitted at the line end with width 0 — the
character survives for copy without contributing a stray selection rect.

RTL is fixed by the same change rather than scoped out: because carriers stay in
flow, DOM order remains logical while `left` supplies the visual offset, so
`RichText.positionedRuns()` (which sorts by source index) copies correctly with
decreasing `x`.

Covered by new unit tests in both packages and by three e2e cases — justified,
a natural-flow control, and justified RTL — asserted through a layout-aware
`innerText` probe across all 8 Chromium and Firefox configurations.
