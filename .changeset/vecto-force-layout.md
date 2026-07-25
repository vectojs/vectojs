---
"@vectojs/graph3d": minor
---

Add `VectoForceLayout` — an in-house, dependency-free 3D force-directed graph layout, offered as an alternative `GraphLayout` to the `d3-force-3d`-backed `D3ForceLayout`.

It is a **new force model**, not a d3 adapter: repulsion is an in-house **Barnes-Hut octree** N-body (O(N log N) per tick), combined with link springs, an origin-centering pull, velocity-decay integration, and alpha cooling. It is deterministic (a seeded PRNG places un-seeded nodes, so a given graph lays out identically every run), computes in f32 throughout, and implements the full `GraphLayout` contract including `pinNode`/`unpinNode`/`reheat` for interactive drag. It has **no runtime dependency on d3-force-3d** — apps that don't need d3 can drop it.

Real-hardware benchmark (`benchmarks/graph-layout`, per-tick cost vs `D3ForceLayout` on the same graph, Chrome 150 + Firefox 153): **4.2–7.2× faster on Chrome, 5.0–8.3× on Firefox** across 500–5000 nodes, with the margin widening as the graph grows (the Barnes-Hut O(N log N) advantage). A matching Rust/WASM kernel that accelerates this exact model (differential-tested against it) is a planned follow-up.
