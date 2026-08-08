---
"@vectojs/core": patch
---

fix(core): strip the inherited coarse text node when promoting a content-grid block

A block promoted from the coarse (resident) semantic tier to the fine tier
arrives holding one text node: the coarse branch projects the whole block as
`el.textContent = projection.text`. `syncContentGridProjection` then addresses
carriers through `el.children` and trims the tail with `lastElementChild` —
both element-only views — so the inherited text node was invisible to the entire
function and simply stayed put alongside the new per-cell carriers.

`el.textContent` consequently read the block twice (probed: 78 characters for a
39-character source, exactly 2x). Find-in-page matched the orphaned copy at the
wrong geometry, a screen reader announced the block twice, and the dev-mode
projection equality check compared against a doubled string.

The grid path cannot open with `el.replaceChildren()` the way the non-grid
carrier branch does — reuse of unchanged carrier lines is what keeps streaming
affordable — so it now removes direct text-node children specifically, leaving
element children (and therefore carrier reuse) untouched. A selection anchored in
the removed text node is released rather than left pointing at a detached node;
`contentGridSelectionLine` could not cover that case because it only recognizes
carrier lines via `data-vecto-grid-line`.

Guarded on `el.firstChild !== null`, so the steady state (streaming append,
scroll) pays one property read and no DOM writes.

Unit test: `packages/core/test/ContentGridPromotion.test.ts` (verified fail-old:
2 of 5 assertions fail without the strip, reporting the doubled text).
