---
'@vectojs/ui': patch
---

fix: extend per-grapheme carriers to RichText, so Markdown body text stops drifting on Firefox

The per-grapheme carrier fix shipped in `@vectojs/ui@2.15.2` only reached
`ui/Text`. `RichText` — which every `@vectojs/markdown` paragraph, heading and
list item renders through — never entered the corrected path, so the drift it
was supposed to remove was still fully present on any Markdown page. Measured on
a real blog page built against `2.15.2` on Firefox 153.0 at dpr 1.5789: **0 of
its projected lines carried per-grapheme carriers**, across 21 content
projections and 46 visual lines.

Cause is a gate that reads as an exclusion but acts as an omission. `Scene`
reaches the per-grapheme branch only for a line with no `runs`, and
`RichText.buildVisualLineGroups()` emitted `runs` unconditionally — either
`positionedRuns()` when justified or `logicalRuns()` otherwise. A `logicalRuns`
line carries no `x` on any run, so it took neither the positioned-carrier path
nor the per-grapheme path and fell through to a plain concatenated text node,
which is exactly the single-text-node case that drifts. The earlier note that
"RichText always emits runs and never reaches the same branch" was recorded as a
reason the flag needed to be explicit; it was equally the reason `RichText` was
silently left uncorrected, and nothing failed, because the drift is invisible to
every existing assertion.

`RichText` now sets `perGraphemeCarriers` and omits `runs` for a line that is
ragged (not justified), not bidi (no node with `isRTL`), and **single-style**
(`logicalRuns` collapsed to one run). Mixed-style lines deliberately keep their
styled runs: the carrier loop applies one font per line, so routing an inline
bold, italic or resized run through it would drop that styling — a visible
regression traded for an invisible sub-pixel one. Bidi stays excluded for the
same caret hit-mapping reason as `Text` (PR #146).

Two behaviour notes for consumers reading the projection directly: a ragged
single-style `RichText` line now reports `runs === undefined` where it
previously reported one unpositioned run, and `perGraphemeCarriers === true`.
Justified, bidi and mixed-style lines are unchanged.

Covered by two `RichText` unit tests pinning both directions — single-style takes
carriers with no runs, mixed-style keeps runs with no `x`. `@vectojs/ui` 593
tests, `@vectojs/core` 933 tests and the full e2e matrix (8 Firefox + 4 Chromium,
including the ligature width-parity case) pass.
