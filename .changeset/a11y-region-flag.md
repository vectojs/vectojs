---
'@vectojs/core': minor
---

feat(core): add `Entity.a11yRegion` to group projected text into a selection region without clipping

The a11y projection orders every content-projection mirror into visual reading
order per _region_, where a region is the nearest enclosing ancestor that
establishes one. Regions keep side-by-side columns as contiguous DOM runs so
that a vertical text drag stays inside the column it started in and cannot reach
a sibling column.

Before this change only `clipChildren` established a region, and only when the
node's box was non-zero (a zero-area clipper clips nothing). That coupling meant
a sidebar, a card deck or any element that exists purely as a column boundary had
to set `clipChildren` to escape its neighbours' row bands — buying a per-frame
`save`/`clip`/`restore` for an entity that paints nothing. Measured in the
xuepoo-blog TOC sidebar before the fix: nine TOC rows were interleaved with body
paragraphs in DOM order, so selecting two body paragraphs also selected the whole
TOC.

`Entity.a11yRegion = true` declares the grouping directly, without touching the
rendering clip. Unlike `clipChildren`, it is honoured regardless of the node's
box size — a grouping container commonly draws nothing and leaves `width`/`height`
at zero, and gating on geometry would silently ignore exactly the entity the flag
exists for. Three new tests cover the separation: an `a11yRegion` column keeps
its DOM run contiguous, a zero-area `a11yRegion` node still forms a region while
a same-sized `clipChildren` node does not, and nested regions resolve to the
nearest one.

`clipChildren` continues to establish a region unchanged; the new flag is an
additive opt-in for cases where the two concerns come apart.
