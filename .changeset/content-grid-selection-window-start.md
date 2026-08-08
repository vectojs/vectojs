---
"@vectojs/core": patch
---

fix(core): release a content-grid selection when the window start passes it

`syncContentGridProjection` windows its carrier lines to the interaction band, so
scrolling changes which lines have DOM. It released a live selection only when
`selectionLine >= gridWindow.end`, and that check sat inside the
`while (el.children.length > windowLength)` trim loop — a loop that runs only when
the window SHRANK.

Scrolling so the window's START moves past the selected line takes a different
path entirely: the window keeps its length, nothing is trimmed, and the
materialize loop instead overwrites `children[0..]` with the new window's lines
(a line's DOM slot is its offset from the window start, not its document index).
`rebuiltSelectionLine` was therefore never set, leaving the live `Selection`
pointing at a replaced, detached carrier while `contentGridSelectionLine`
reported a stale index — so a subsequent copy read the wrong text.

The bounds test is now a single combined check on both edges, hoisted above the
materialize loop so it is evaluated on every rebuild regardless of whether the
window shrank, and the now-redundant in-loop check is gone rather than left
firing on a different condition.

The release itself stays deferred to after the loops (`if (rebuiltSelectionLine)`)
so a selection in a REUSED line still survives: carrier-line reuse is what makes
streaming affordable, and releasing on any rebuild would wipe the selection on
every appended chunk. That over-release direction is covered too.

Unit test: `packages/core/test/ContentGridSelectionWindow.test.ts` (5 tests,
verified fail-old — the start-passes-selection case fails without the fix while
the end case still passes, confirming the two conditions cover different paths).
