---
"@vectojs/ui": minor
"@vectojs/markdown": patch
---

`VirtualList`: track rows that keep resizing after they mount.

A row's height was read once, on the frame it mounted, and never again — so a
streaming Markdown row that kept growing never updated its Fenwick entry and the
list's geometry drifted further from the truth with every chunk. Every mounted row's
`height` is now re-read each frame and any change applied as an O(log n) point
update.

New `keyForItem` option. Supplying it gives stable row identity, which enables three
things index identity cannot express:

- **Measured heights survive `setItems`**, so appending to a transcript re-measures
  nothing. Previously `setItems` cleared every measurement and jumped to the top,
  which is right for a replaced list and wrong for a growing one. That remains the
  behaviour when `keyForItem` is absent.
- **The scroll position is anchored across resizes.** If the viewport was following
  the bottom it keeps following; otherwise the row under the top edge stays exactly
  where it was, however much the rows above it changed height. The anchor keeps its
  offset _within_ the anchored row, clamped in case that row itself shrank.
- **Prepend works.** A prepend shifts every index, so the pooled entities are rekeyed
  along with the heights.

New `jumpToBottom()` — the instant counterpart to `scrollToBottom()`, and what
streaming content should call. Retargeting the scroll integrator on every chunk never
lets it settle, so the viewport chases the content instead of tracking it;
`ScrollView.scrollToBottom` already snapped for this reason.

New `stickToBottomThreshold` option (default `48`): how close to the bottom counts as
"following". Following is latched at the last user scroll rather than re-derived when
a row resizes, because a resize changes the distance to the bottom without the user
having moved.

Measurement is a poll rather than a notification. `Entity.width`/`height` are plain
fields with no setter and no dirty flag, so there is nothing to subscribe to, and
reading `ent.height` costs exactly what reading a version counter would — the check
_is_ the work. Polling is also more general: it catches a height change by any
mechanism, including a caller assigning `height` directly. The no-change path is one
map lookup and one float compare per mounted row (~10-16) and deliberately does not
mark the scene dirty, so the idle throttle is preserved.

Two fixes fall out of this:

- A row measured on its mount frame positioned every row below it against the stale
  estimate, so a freshly mounted variable-height row settled one frame late.
  `_reconcile` now mounts, then measures, then positions.
- `Markdown.onLayoutUpdated` is documented as unnecessary for this (and as an
  incomplete size signal, since it fires from the append path but not from
  `setContent`). It has no callers and needs none.
