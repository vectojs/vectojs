---
'@vectojs/graph3d': patch
---

Backlog consistency sweep (#658): uniform unknown-link-id policy and disposal hygiene.

- Unknown link endpoints now throw the same `references an unknown node id` error across all three stacks: `Graph3D.setGraphData` (already threw), `VectoForceLayout.setGraph` (previously silently skipped the link), and `D3ForceLayout.setGraph` (previously let the raw id reach d3-force-3d, whose tick read `.x` off the string and silently collapsed every position to NaN). Validation runs before any state mutates, so a rejected graph leaves the previous one intact.
- Self-loops still carry no spring in `VectoForceLayout` (unchanged skip).
- `VectoForceLayout.dispose()` now releases the WASM force backend reference and resets the Barnes-Hut octree scratch instead of pinning kernel memory while the disposed layout lingers.
