---
'@vectojs/core': minor
---

Virtualize content projection: only materialize near-viewport text as DOM.

`Scene.syncContentProjection` previously created a transparent, position-synced
DOM node (plus a `<span>` per visual line) for **every** text entity in the
scene, regardless of viewport — a document taller than the screen materialized
one element per block for the whole document (measured ~14.8k DOM elements /
9.4k text nodes for a 346KB Markdown reader). Off-viewport nodes were merely
`display:none`-hidden, so they still cost heap and forced the browser to reflow
all of them whenever the view scrolled — the cause of choppy large-document
scrolling, a ballooning heap, and (once the a11y sync was throttled to cope)
text-selection lagging the rendered glyphs.

The projection is now viewport-virtualized like canvas rendering already is:
only entities whose world box is within a margin of the viewport (and of every
`clipChildren` ancestor) are materialized; nodes are freed when they scroll past
the margin and re-created when they return. This bounds the projected DOM to the
visible working set, so heap stays flat and per-frame content sync stays cheap
enough to run every frame (keeping selection glued to the glyphs).

New `SceneOptions.contentProjectionMargin` (CSS px, each side; default one
viewport height) tunes how much off-screen text stays ready for native
find-in-page / selection; `Infinity` restores the previous
materialize-everything behavior.
