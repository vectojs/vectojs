---
'@vectojs/graph-layout': patch
---

Clear the graph-layout backlog (#659): single max-radius scan per collision tick, pinning docs

- **`applyGridCollisions` takes the precomputed `maximumRadius`** instead of
  rescanning all radii internally — the caller already needed the same O(N)
  max-radius walk for its early-out, so collisions-enabled ticks ran it twice.
  The class lives under `src/internal/`, but the signature is visible in dist
  types, hence the patch bump.
- **Docs**: `ForceLayout2D.pinNode` documents that this package pins by node ID
  (pins survive `removeNodes` compaction) while the 3D `GraphLayout` contract
  pins by node index, and that parallel-edge identity differs per stack
  (node-editor rejects duplicate endpoint quadruples; the graph/knowledge
  stacks treat parallel links as distinct edges).

Fixes #659 (graph-layout items)
