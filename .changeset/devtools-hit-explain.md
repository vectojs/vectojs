---
'@vectojs/devtools': minor
---

Add `explainHitTest(scene, x, y)`.

Picking returned the entity that received a pointer event but never why, and the
two failure modes that cost the most time — an invisible overlay swallowing clicks,
a control clipped out of its scroll container — look identical from outside.

Returns the winning entity plus every candidate considered with a verdict:
`accepted`, `invisible`, `clipped`, `pointer-transparent`, `outside-shape`, or
`occluded`. Verdicts mirror `Scene.findHitRecursively`'s own rejection conditions.
`formatHitExplanation()` renders the chain as indented lines.
