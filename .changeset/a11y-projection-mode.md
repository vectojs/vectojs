---
"@vectojs/core": minor
---

Add a per-entity `a11yProjection` mode: `'eager' | 'onDemand' | 'never'`.

`'eager'` is the default and keeps today's behaviour, so nothing changes for
existing scenes. `'onDemand'` withholds an entity's a11y shadow node until it is
_engaged_, which makes high-cardinality interactive scenes — particles, danmaku,
graph nodes — affordable for the first time. `'never'` suppresses the node
entirely while leaving the entity hit-testable on canvas.

Measured on 5,000 moving interactive entities (`benchmarks/lazy-a11y/`, real
headed browsers):

|                    | Chrome                      | Firefox                      |
| ------------------ | --------------------------- | ---------------------------- |
| `'eager'` (today)  | 66.4 ms/frame, misses 60 Hz | 114.7 ms/frame, misses 60 Hz |
| `'onDemand'`       | **2.23 ms**                 | **1.69 ms**                  |
| no a11y DOM at all | 1.35 ms                     | 1.75 ms                      |

So 30x/68x faster, landing at the floor of projecting nothing — while every
entity stays individually reachable.

**Engagement is deliberately not hover-only.** A keyboard or assistive-technology
user generates no pointer events, so a hover-gated node would be withheld from
exactly the users it exists for. Three signals count: focus (a focused node is
never pruned out from under the user), the pointer being inside the entity, and
an explicit `Scene.requestA11yProjection(entity)` / `releaseA11yProjection(entity)`
for anything the app knows matters — a selection, a search hit, a live-region
announcement. The entity stays hit-testable throughout, so a click always reaches
it and promotes it.

Pointer engagement is skipped for an entity that projects **selectable text** of
its own: its interactive node carries `pointer-events: auto` and stacks above the
transparent text mirror, so materializing one under the pointer swallows the
mousedown and native drag-selection never starts. Such entities remain reachable
by focus and explicit request.

`'onDemand'` does not replace an aggregate description. A thousand reachable
danmaku still say nothing collectively; pair it with one live region plus a small
pool of persistent hotspots for the current selection.
