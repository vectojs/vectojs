---
'@vectojs/knowledge-graph': minor
---

Clear the knowledge-graph backlog (#659): settle-only warm-start capture, in-flight expansion dedupe

- **Warm-start positions are captured only when the layout settles**:
  `KnowledgeGraphSession.tick()` no longer calls `model.captureLayoutPositions()`
  every hot frame (one Map entry per node per frame); the model's own capture at
  rebuild time and the single settling-tick capture keep the cache correct.
- **One shared expansion per id**: repeated selects on a node whose expansion
  fetch is still in flight are swallowed by an in-flight-id gate instead of
  firing `onExpand`/`onError` once per click for a single network fetch.
- **Docs**: `FixedZLayout` notes that the `GraphLayout` contract pins by node
  index while graph-layout's `ForceLayout2D` pins by node ID (parallel-edge
  identity also diverges between stacks).
- **Breaking**: `KgDataSource.getLabels` removed from the contract (never
  called by model or session) and the unused `toGraphData` identity-cast helper
  removed.

Fixes #659 (knowledge-graph items)
