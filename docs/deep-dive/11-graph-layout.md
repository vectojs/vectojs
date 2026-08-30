---
title: "11 — Graph Layout — Force-Directed Physics & Benchmarking"
description: "ForceLayout2D's dependency-free 2D engine, Barnes-Hut quadtree and tiered collision grid, incremental mutation and pin contracts, the VectoForceLayout/D3ForceLayout 3D family, the vectojs-force-rs WASM kernel, and headed benchmark methodology."
order: 31
---

# 11 — Graph Layout — Force-Directed Physics & Benchmarking

> **Boss 11** looks like "springs and repulsion" until you ship it. The naive N-body is O(N²) per tick, a single hub collapses naive collision grids, incremental expansion must not destroy settled state, and two users must see the same layout from the same seed. VectoJS answers with a renderer-agnostic 2D quadtree plus tiered grid in `@vectojs/graph-layout`, a parallel 3D octree family in `@vectojs/graph3d`, and a bit-identical Rust kernel in `crates/vectojs-force-rs`.

- **What you'll learn**: why N², stability, incrementality, and determinism are the four hard problems; how `ForceLayout2D` stores SoA state and exposes `Float32Array` positions; how repulsion (Barnes-Hut), link springs, centering, and collision compose per tick; why the 2D quadtree and tiered collision grid replaced naive grids; how pins, ID mappings, reheating, and alpha cooling interact; how `VectoForceLayout` vs `D3ForceLayout` vs `FixedZLayout` differ and where `KnowledgeGraphModel` consumes them; what the WASM force kernel replaces and how it stays bit-identical; and what `benchmarks/graph-layout` actually measures (and what it explicitly does not).
- **What you won't**: VMT dirty/lifecycle (boss 06), renderer/DPR correctness (boss 07), or the G1/G2/G3 WASM triple (boss 08) — though this boss reuses boss 08's invisible-backend contract verbatim. Text shaping (boss 02) and streaming Markdown (boss 04) are consumers of graph layout, not the other way around.

## 1. Why force layout is deceptively hard

Four problems hide behind "springs and repulsion":

1. **N² vs Barnes-Hut.** Repulsion is every-node-against-every-other-node. At 3000 nodes that is ~9M pair forces per tick, per frame, on the main thread or a worker. A true 2D quadtree (`BarnesHutQuadtree.ts:8` flat-array, reused across ticks) makes this O(N log N) by treating distant cells as one pseudo-particle when `size/distance < theta` (`BarnesHutQuadtree.ts:121` opening test `4*half² < theta²*d²`). The 3D side does the same with an octree (`VectoForceLayout.ts:402` `BarnesHutOctree`). Without it, graphs above a few hundred nodes jank.

2. **Stability under heterogeneous radii.** A single hub with radius 100 next to 3000 leaves with radius 4 collapses a uniform collision grid: one `cellSize = 2·maxRadius` puts every leaf in a giant 3×3 neighbourhood and pair scans degenerate to quadratic (the comment at `BarnesHutQuadtree.ts:189` measures `12 ms → 197 ms` per tick going 3k → 12k with one large hub). The fix is a power-of-two radius tier grid (`BarnesHutQuadtree.ts:190` tier `t = floor(log2(r))`, cell `Ct = 2^(t+2)`), where each tier owns its hash table and cross-tier pairs resolve exactly once.

3. **Incrementality without teleport.** Knowledge graphs page in: 50 nodes now, 50 more after scroll. Callers expect `appendGraph` to keep every existing position, velocity, and pin exactly where it was, add only the new nodes deterministically, and reheat gently (`ForceLayout2D.ts:162` `appendGraph`, `ForceLayout2D.ts:199` `if (newNodes.length>0||addedLinks>0) this.reheat()`). `setGraph`-rebuild (`ForceLayout2D.ts:123`) would teleport the settled graph.

4. **Determinism across platforms.** `seed` must reproduce the same initial placement and the same coincident-point jitter on JS and Rust, so tests, snapshots, and future WASM differential oracles agree bit-for-bit. The chosen maths are `mulberry32` (`ForceLayout2D.ts:868`), `Math.sqrt` (not `Math.hypot` — engine-approximated, `VectoForceLayout.ts:618` note), and integer `Math.imul` jitter (`BarnesHutQuadtree.ts:618` `collisionPairAngle`, `VectoForceLayout.ts:606` `jitterFor` / `crates/vectojs-force-rs/src/lib.rs:83` `jitter_for`).

Miss any one and the graph either janks, explodes, teleports, or diverges between JS and WASM.

## 2. Package map

```text
@vectojs/graph-layout          dependency-free 2D engine, no renderer peer
  src/ForceLayout2D.ts         the tick loop, SoA stores, public API
  src/types.ts                 NodeId/GraphData/ForceLayout2DOptions
  src/internal/BarnesHutQuadtree.ts  quadtree + tiered collision grid
  src/index.ts                 barrel (types + layout)

@vectojs/graph3d               3D instanced renderer + layout backends
  src/layout/GraphLayout.ts    minimal 3D contract (setGraph/step/positions/pin/reheat/dispose)
  src/layout/VectoForceLayout.ts  in-house 3D Barnes-Hut octree (JS oracle + WASM)
  src/layout/D3ForceLayout.ts  d3-force-3d adapter (migration fidelity)
  src/wasm/force-backend.ts    streaming/sync loader for the Rust kernel
  src/wasm/asset.ts            forceWasmUrl bundler helper
  src/wasm/vectojs_force.wasm  gitignored output of vectojs-force-rs

@vectojs/knowledge-graph       paginated consumer (KnowledgeGraphModel)
  src/KnowledgeGraphModel.ts   single driver of a GraphLayout (setGraph/reheat)
  src/FixedZLayout.ts          VectoForceLayout with z clamped to a plane
  src/KnowledgeGraphSession.ts factory wiring (theta 0.9, WASM opt-in)

crates/vectojs-force-rs        WASM octree force kernel (invisible backend)
  src/lib.rs                   build + force-accumulate only, f64 accumulators

benchmarks/graph-layout        headed 4-arm matrix (d3-force-3d, vecto-force, d3-force-2d, force-layout-2d)
benchmarks/graph3d-frame       frame-cost harness for the 3D renderer (not the physics matrix)
benchmarks/_shared/*           single server + bundler + stats + runner (run-browsers.sh)
```

`@vectojs/graph-layout` has zero `@vectojs/*` deps (`package.json:1` `name: @vectojs/graph-layout`); `@vectojs/graph3d` depends on `three` only; `@vectojs/knowledge-graph` depends on `graph3d`'s layout contract. Build order: `math+text → graph-layout → three/graph3d → knowledge-graph` (verified via `package.json` workspaces).

## 3. ForceLayout2D — the 2D engine

### 3.1 State and the positions contract

SoA typed arrays, index-aligned with the input node order (`ForceLayout2D.ts:48` `nodes: GraphNode[]`, `ForceLayout2D.ts:49` `nodeIndex: Map<NodeId,number>`, `ForceLayout2D.ts:50` `positionStorage: Float32Array`, `ForceLayout2D.ts:51` `velocityX/Y`, `ForceLayout2D.ts:53` `fixedX/Y` + `pinnedX/Y`, `ForceLayout2D.ts:57` `repulsion`/`collisionRadius`, `ForceLayout2D.ts:60` `linkSource/Target/Distance/Strength/Share`, `ForceLayout2D.ts:76` `quadtree`).

Public `positions` is a live interleaved XY view into `positionStorage` in input-node order (`ForceLayout2D.ts:32` `public positions = new Float32Array(0)`, `ForceLayout2D.ts:748` `refreshPositionView` via `subarray`). Identity is stable across `step()` calls, but topology or capacity changes may replace the backing store — hosts must reacquire `positions` after `setGraph`/`appendGraph`/`removeNodes` (class doc `ForceLayout2D.ts:18`).

All arithmetic that touches public state is rounded through `Math.fround` (`ForceLayout2D.ts:13` `const f = Math.fround`, `ForceLayout2D.ts:808` `toF32`), matching the `Float32Array` exposure. The 3D path does the same (`VectoForceLayout.ts:48` `const f = Math.fround`) while the Barnes-Hut accumulators stay `f64` (`BarnesHutQuadtree.ts:9` `cellX/Y/centerX/Y/halfSize/charge: Float64Array`).

### 3.2 Node/link identity and incremental mutation

Nodes are addressed everywhere by `NodeId` (`types.ts:2` `string|number`), not by array index, so pins survive compaction (`ForceLayout2D.ts:25` doc). Four mutation entry points, each with a strict all-or-nothing validation:

| method               | doc                    | ownership                                          | failure mode                                                                                                                            |
| -------------------- | ---------------------- | -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `setGraph(data)`     | `ForceLayout2D.ts:122` | replace everything, reseed, `alpha=1`              | duplicate node ID or link referencing missing/self → throw before clearing old state (`ForceLayout2D.ts:132` validate-before-swap)      |
| `appendGraph(data)`  | `ForceLayout2D.ts:151` | keep existing, add new IDs, dedup                  | unknown/missing/self link → throw before any mutation (`ForceLayout2D.ts:186` `resolveEndpoint` + `UNKNOWN_ENDPOINT` guard)             |
| `removeNodes(ids)`   | `ForceLayout2D.ts:202` | compact survivors in original order, rebuild index | no-op when nothing matches; reheats once (`ForceLayout2D.ts:252`)                                                                       |
| `removeLinks(items)` | `ForceLayout2D.ts:265` | keep node state, compact links                     | matched by directed `(source,target,id)` identity (`ForceLayout2D.ts:826` `linkIdentity`); idempotent                                   |
| `updateLinks(links)` | `ForceLayout2D.ts:324` | re-resolve distance/strength for existing links    | unknown/identical endpoints → throw; non-existing identity ignored; reheats only when a value actually changed (`ForceLayout2D.ts:361`) |

Link identity is the subtle trap. `ForceLayout2D.ts:826` `linkIdentity` serialises `[idKey(source), idKey(target), idKey(id)]` where `idKey` (`ForceLayout2D.ts:835`) prefixes the type to avoid `"1"` vs `1` collisions. Without an `id`, identity is the directed endpoint pair; parallel links require distinct `id`s (`types.ts:19` `GraphLink.id`). The 3D backends differ: `VectoForceLayout` and `D3ForceLayout` treat every `(source,target)` pair as a link and even skip self-loops (`VectoForceLayout.ts:178` `if (ia===ib) continue`), while the editor's duplicate-link guard is stricter — pointed out in the divergence note at `ForceLayout2D.ts:387`.

`appendLinks` (`ForceLayout2D.ts:637`) dedups within the batch via `pendingKeys` and resolves `distance`/`strength` through the caller-supplied `NodeValue`/`LinkValue` accessors (`ForceLayout2D.ts:777` `resolveNodeValue`, `ForceLayout2D.ts:787` `resolveLinkValue`), with `finiteOr` guards (`ForceLayout2D.ts:797`).

Capacity growth is geometric, amortised O(1) (`ForceLayout2D.ts:851` `grownCapacity` doubling from 4, `ForceLayout2D.ts:672` `ensureNodeCapacity`, `ForceLayout2D.ts:689` `ensureLinkCapacity`, `ForceLayout2D.ts:857` `resize` preserving prefix).

### 3.3 The tick — six phases

`tick()` (`ForceLayout2D.ts:480`) is synchronous and host-driven (`step()` at `ForceLayout2D.ts:368` loops `tick()` while `alpha >= alphaMin`). No timer is owned — the host decides when to call `step()` (class doc `ForceLayout2D.ts:21`).

```text
sanitizeState → quadtree.build → repulsion (Barnes-Hut per node)
              → link springs → collision grid → centering+integrate+pin clamp → alpha decay
```

Each phase in detail:

1. **Sanitize** (`ForceLayout2D.ts:752`) — `toF32` every position/velocity/pin/repulsion/radius so a stray NaN cannot poison the tree; pinned coords overwrite stored positions.

2. **Tree build** (`ForceLayout2D.ts:483` `quadtree.build(positions, repulsion, nodeCount)`) — see §5.

3. **Repulsion** (`ForceLayout2D.ts:484` loop calling `quadtree.force(qx,qy,theta,nodeIndex,out,maxDistance)`) — inverse-square `(-charge / d³) * (dx,dy)` with `distanceSquared` floored at `1e-6` and deterministic `pairAngle` for exact coincidences (`BarnesHutQuadtree.ts:126` / `BarnesHutQuadtree.ts:610` `pairAngle`). Respects `repulsionDistanceMax` (`ForceLayout2D.ts:92` non-finite = no cutoff; `BarnesHutQuadtree.ts:85` `maxDistanceSquared` + nearest-cell pre-test `distanceToCellSquared` at `BarnesHutQuadtree.ts:632`). The 3D side uses the same floor and `jitterFor` in the octree insert.

4. **Link springs** (`ForceLayout2D.ts:499`) — Hooke-like `displacement = ((d - rest)/d) * strength * alpha`, split by degree-weighted shares (`ForceLayout2D.ts:701` `recomputeLinkBias`: `sourceShare = targetDegree/total`, floored via `springShare` when a pin fixes an endpoint at `ForceLayout2D.ts:846`). Uses predicted positions for pinned targets so a pinned node still pulls.

5. **Collision** (`ForceLayout2D.ts:580` `applyCollisions` → `BarnesHutQuadtree.ts:172` `applyGridCollisions`) — tiered grid, §5.

6. **Center + integrate** (`ForceLayout2D.ts:554` `center*alpha` pull toward origin, velocity decay, then per-axis pin clamp: pinned axes snap to `fixedX/Y` and zero velocity). **Cool** (`ForceLayout2D.ts:577` `alpha += (0-alpha)*alphaDecay`) with the `alphaDecay > 0` guard at `ForceLayout2D.ts:95` because `0` would loop forever (`step()` at `ForceLayout2D.ts:372` `while (alpha>=alphaMin)`).

## 4. Forces as configuration

`ForceLayout2DOptions` (`types.ts:42`) and `VectoForceLayoutOptions` (`VectoForceLayout.ts:12`) expose the same model with different defaults:

| knob                           | 2D default (`types.ts:43`) | 3D default (`VectoForceLayout.ts:14`)            | role                                                            | tuning hint                                                                                                                                                    |
| ------------------------------ | -------------------------- | ------------------------------------------------ | --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `repulsion` / `chargeStrength` | `300` (positive strength)  | `300` (VectoForce) / `-30` (D3 `chargeStrength`) | N-body push apart                                               | increase to separate hubs; 2D clamps negative to `0` (`ForceLayout2D.ts:629`/`ForceLayout2D.ts:761` and `BarnesHutQuadtree.ts:109` `charge<=0 skip` invariant) |
| `collisionRadius`              | `0` (off)                  | n/a (graph3d has no 2D grid)                     | per-node radius, `0` disables (`ForceLayout2D.ts:582` max scan) | set via accessor to `radius+14` in bench (`entry.ts:631`)                                                                                                      |
| `collisionStrength`            | `1`                        | —                                                | fraction of overlap corrected                                   | `0` skips the whole pass                                                                                                                                       |
| `linkDistance`                 | `30`                       | `30`                                             | spring rest length                                              | accessor per link degree in bench (`entry.ts:632`)                                                                                                             |
| `linkStrength`                 | `0.3`                      | `0.3`                                            | spring stiffness `[0,1]`                                        | `0` = links exert nothing                                                                                                                                      |
| `centerStrength`               | `0.02`                     | `0.02`                                           | pull toward origin                                              | `0` = free-floating graph                                                                                                                                      |
| `velocityDecay`                | `0.6`                      | `0.6`                                            | `1-friction`, retention `[0,1)`                                 | lower = more damping                                                                                                                                           |
| `theta`                        | `0.9`                      | `0.9`                                            | Barnes-Hut opening angle                                        | `0` = exact O(N²); larger = faster/looser                                                                                                                      |
| `repulsionDistanceMax`         | `Infinity`                 | `Infinity` (not exposed separately in 3D bench)  | GC of distant repulsion                                         | `Infinity`/non-finite = no cutoff (`ForceLayout2D.ts:91`); `0` also disables per `BarnesHutQuadtree.ts:77` early-return — a silent footgun                     |
| `alphaDecay` / `alphaMin`      | `0.0228` / `0.001`         | `0.0228` / `0.001`                               | cooling (`~1-0.001^(1/300)` ≈300 ticks to settle)               | `0` decay falls back to `0.0228` (`ForceLayout2D.ts:96`)                                                                                                       |

Accessor form `number | ((node, index)=>number)` (`types.ts:38` `NodeValue`, `LinkValue`) lets docs map entity size to radius without rebuilding. Link shares are recomputed on every topology change (`ForceLayout2D.ts:702`).

## 5. Two spatial indices

### 5.1 2D Barnes-Hut quadtree

`BarnesHutQuadtree.ts:8` is a flat-array quadtree reused per tick. `build()` (`BarnesHutQuadtree.ts:36`) derives square bounds from the position AABB (`+1e-6` slop), ensures capacity (`BarnesHutQuadtree.ts:531` doubling from 64, `count*4+4` heuristic), and inserts every point (`BarnesHutQuadtree.ts:437` `insert` with `MAX_DEPTH=40` at line 1 — depth guard for coincident points, leaf holds linked list `pointHead→pointNext`). `finalize()` (`BarnesHutQuadtree.ts:485`) walks nodes reverse (children before parents, nodes allocated top-down) accumulating `charge` and `centerX/Y` as mass-weighted averages; the `total>0` guard at `BarnesHutQuadtree.ts:507` pairs with the `charge<=0 skip` invariant noted above — negative charges would require rethinking both.

`force()` (`BarnesHutQuadtree.ts:69`) is an iterative stack traversal (`BarnesHutQuadtree.ts:87` `ensureStack`), with `distanceToCellSquared` (`BarnesHutQuadtree.ts:632`) for the cutoff pre-test and the exact approximation test at `BarnesHutQuadtree.ts:117`.

### 5.2 Tiered collision grid

`applyGridCollisions` (`BarnesHutQuadtree.ts:172`) exists because collision is a _different_ spatial query than repulsion (short-range overlap, not long-range field). Key ideas:

- **Tier assignment** (`BarnesHutQuadtree.ts:206` `tier = floor(log2(radius))`, cell `4*2^tier` at `BarnesHutQuadtree.ts:267`) — uniform radii collapse to one tier, behaving like the old `2·maxRadius` grid; the `cellSize < r_i+r_j` bound at `BarnesHutQuadtree.ts:198` guarantees a 3×3 probe finds every overlap.
- **Zero-radius sentinel** (`BarnesHutQuadtree.ts:5` `ZERO_TIER = -0x40000000`, `BarnesHutQuadtree.ts:222` bucket) — zero-radius points never own a grid but still collide as initiators against larger tiers.
- **Counting sort by tier** (`BarnesHutQuadtree.ts:240` prefix-sum into `collisionOrderOffsets`, `BarnesHutQuadtree.ts:248` cursor fill) — O(N) and span-safe: offset tables are sized by _tier span_, not point count, because `f32` radii span ~280 powers of two (`BarnesHutQuadtree.ts:237` comment, `BarnesHutQuadtree.ts:587` `ensureCollisionOffsets`).
- **Deduplicated 3×3 probe** (`BarnesHutQuadtree.ts:349` `probeCollisionCell`) — 9 slots, linear-probe hash `imul(cellX,73856093)^imul(cellY,19349663)` (`BarnesHutQuadtree.ts:596`), duplicate-cell filter at `BarnesHutQuadtree.ts:372`, pair-once rule (`sameTier && target<=source` skip at `BarnesHutQuadtree.ts:390`; cross-tier needs no skip — each larger-tier pair is visited exactly once by its smaller initiator).
- **Share-aware impulse** (`BarnesHutQuadtree.ts:406` `pinned?0:otherPinned?1:0.5`) — mirrors spring shares but clamped to half when both free (d3-force uses radius-weighted shares; the comment at `entry.ts:745` flags the comparison caveat).

The 3D octree (`VectoForceLayout.ts:402`) mirrors this structure in 3D: `BarnesHutOctree.build` cubes the AABB, `insert` with the same `depth < 40` guard and deterministic `jitterFor` for coincident points (`VectoForceLayout.ts:561`), `finalizeMass` bottom-up, `force` with `size² < theta²*d²` and `pointIndex` identity skip (`VectoForceLayout.ts:726`) rather than distance-zero skip — coincident distinct points are jittered apart and must still exert force.

## 6. Pins, reheating, determinism

**Pins are per-axis, ID-addressed.** `ForceLayout2D` pins by `NodeId` (`ForceLayout2D.ts:393` `pinNode(id,x,y)`, `ForceLayout2D.ts:413` `setNodePin({x?,y?})`, `ForceLayout2D.ts:436` `clearNodePin`) storing `fixedX/Y` + `pinnedX/Y` (`ForceLayout2D.ts:53`); graph3d's `GraphLayout` pins by _index_ (`GraphLayout.ts:46` `pinNode(nodeIndex,x,y,z)`, `VectoForceLayout.ts:337` `fx/fy/fz = NaN` sentinel vs `D3ForceLayout.ts:122` `fx/fy/fz = null`). The divergence is documented at `ForceLayout2D.ts:387` — translate when crossing stacks. Initial `fx/fy` on a `GraphNode` (`types.ts:12`) are honoured at `ForceLayout2D.ts:619` `addNode` as pre-pins.

**Reheating raises alpha but never lowers it** (`ForceLayout2D.ts:450` `alpha = max(alpha, requested)`, `VectoForceLayout.ts:359` same, `D3ForceLayout.ts:150` `alpha = max(alphaMin, min(1,alpha))`). Every topology mutation reheats once (`ForceLayout2D.ts:199`, `ForceLayout2D.ts:252`, `ForceLayout2D.ts:308`, `ForceLayout2D.ts:361` conditional) — callers do not need to remember. The knowledge-graph path reheats explicitly at `KnowledgeGraphModel.ts:285` `layout?.reheat?.(0.5)` after `rebuildGraph`, which itself calls `layout?.setGraph` at `KnowledgeGraphModel.ts:356`.

**Determinism** is three-fold: seeded `mulberry32` spiral placement (`ForceLayout2D.ts:613` `radius=10*sqrt(i+1), angle=rand()*2π` / `VectoForceLayout.ts:143` `r=10*cbrt(i+1)` spherical), deterministic coincident-angle via `deterministicAngle` (`ForceLayout2D.ts:878` hashed from `(source,target,seed)`) and `collisionPairAngle` (`BarnesHutQuadtree.ts:618` seeded), and identical floating-point choices across JS and Rust (the `Math.hypot` trap above).

**Cooling** uses `alphaDecay = 0.0228` (`≈ 1-0.001^(1/300)`, same as d3-force-3d's default, `VectoForceLayout.ts:32` comment) with `alphaMin = 0.001`; `step()` returns `alpha >= alphaMin` as "still hot" (`ForceLayout2D.ts:375`), matching the `GraphLayout` contract (`GraphLayout.ts:26` doc). An undisposed `alpha=0` never cools — guarded at construction.

## 7. The 3D family and the Knowledge Graph consumer

### 7.1 VectoForceLayout vs D3ForceLayout

Both implement `GraphLayout` (`GraphLayout.ts:12` — flat `Float32Array` of xyz triplets in `GraphData.nodes` order, worker-transferable, host-driven `step()`). Differences:

- **Model:** `VectoForceLayout` (`VectoForceLayout.ts:50`) is a _new_ model — Barnes-Hut octree repulsion (`VectoForceLayout.ts:402`), link springs, centering, velocity decay, alpha cooling — deterministic and dependency-free. `D3ForceLayout` (`D3ForceLayout.ts:25`) is a _d3-force-3d adapter_ (`forceSimulation(…,3).force('link', forceLink).force('charge', forceManyBody).force('center', forceCenter)` at `D3ForceLayout.ts:88`), keeping the feel of `3d-force-graph` for migration.
- **State ownership:** `VectoForceLayout` keeps `positions/vx/vy/vz/fx/fy/fz/linkA/B` SoA (`VectoForceLayout.ts:87`) and never mutates caller nodes; `D3ForceLayout` clones into `simNodes: SimulationNode[]` (`D3ForceLayout.ts:71`) because d3 mutates them.
- **Pins:** index-based `fx/fy/fz` NaN vs `null` sentinel; `VectoForceLayout.tick` clamps before integration (`VectoForceLayout.ts:308`), d3's `fx` does the same inside its tick.
- **Alpha:** `VectoForceLayout.reheat` floors at `alphaMin` and caps at `1` (`VectoForceLayout.ts:361`); `D3ForceLayout.reheat` writes `simulation.alpha()` directly (`D3ForceLayout.ts:151`).

`FixedZLayout` (`knowledge-graph/src/FixedZLayout.ts:10`) wraps `VectoForceLayout` and clamps every `z` to a constant after the inner step, letting a 3D layout drive a 2D knowledge-graph view without swapping engines. `KnowledgeGraphSession` (`knowledge-graph/src/KnowledgeGraphSession.ts:59` doc "the session only mirrors") constructs a `VectoForceLayout({theta:0.9})` at line 117 and delegates `setGraph`/`reheat` to `KnowledgeGraphModel`.

### 7.2 KnowledgeGraphModel — the incremental consumer

`KnowledgeGraphModel` (`knowledge-graph/src/KnowledgeGraphModel.ts:62`) owns the materialised cut (`entities`, `facts`, `factKeys`, `expansions`) and is the **single driver** of its borrowed `GraphLayout` (`KnowledgeGraphModel.ts:43` doc: one `setGraph` per `rebuildGraph`, one `reheat` per `expand`). On `expand(id)` (`KnowledgeGraphModel.ts:127`) it pages via `KgDataSource.getNeighbors` with `AbortSignal` cancellation (`KnowledgeGraphModel.ts:148` shared-promise dedup, `KnowledgeGraphModel.ts:150` `cancelExpand`), ingests entities/facts, advances `loaded` by _batch_ fact count (not net-new, so overlapping neighbourhoods don't stall progress — comment at `KnowledgeGraphModel.ts:273`), calls `rebuildGraph()` (`KnowledgeGraphModel.ts:332` captures positions, merges in stable `entityOrder`, seeds new nodes from `lastPositions`, writes `GraphData` and calls `layout?.setGraph`), reheats (`KnowledgeGraphModel.ts:285`), and records `ExpansionState` (`KnowledgeGraphModel.ts:7`). `dispose()` (`KnowledgeGraphModel.ts:225`) intentionally does _not_ dispose the borrowed layout — the session may still share it.

### 7.3 WASM — the invisible force kernel

`crates/vectojs-force-rs` (`crates/vectojs-force-rs/Cargo.toml:6` "invisible backend; the TypeScript path is the permanent fallback") mirrors `BarnesHutOctree` in Rust: `Octree` (`lib.rs:47`), `jitter_for` (`lib.rs:83`), `build`/`insert`/`place_child`/`finalize_mass`/`force` (`lib.rs:194` / `lib.rs:401`), exports `force_init`/`force_pos`/`force_accel`/`force_step` (`lib.rs:457` / `lib.rs:484` / `lib.rs:491` / `lib.rs:503`) with `STATUS_OK/CAPACITY/UNINITIALIZED/OVERFLOW` (`lib.rs:31`). The scope is _build + force accumulate only_ (`lib.rs:10` comment — that phase is 78–90% of a 3D tick, `VectoForceLayout.ts:240` phase split) — link springs, centering, integration stay in the JS tick, so the seam is one `Float32Array.set` gather and one `Float64Array` read-back per tick.

The loader (`packages/graph3d/src/wasm/force-backend.ts:42` `ForceBackend`) does streaming fetch with fallback to `arrayBuffer` (`force-backend.ts:104` `instantiateStreaming`), `ensure`/`force_init` growth (`force-backend.ts:52`), `step` gather + `force_step` + stale-view refresh (`force-backend.ts:65` + `force-backend.ts:37` `viewsStale` — the octree can grow linear memory mid-step, detaching views). Failure at any point returns `null` and the caller keeps the JS octree (`VectoForceLayout.ts:106` / `VectoForceLayout.ts:246` fallback to `this.tree.build` + `this.tree.force`; the asset URL is `packages/graph3d/src/wasm/asset.ts:22` `forceWasmUrl` via `new URL('./vectojs_force.wasm', import.meta.url)` — the only bundler-safe form). The `.wasm` is gitignored and copied via `tsup.config.ts:40` at publish, exactly like `vectojs-core-rs`.

Bit-parity is non-negotiable: the Rust tree must compute the same `f64` centers of mass and `f64` repulsion integrals as the JS tree (positions and velocities stay `f32` on both sides). `VectoForceLayout.ts:58` spells this out: "A future Rust/WASM kernel … must therefore reproduce the f64 accumulation exactly." Tests differential-test the two paths bit-for-bit (see `packages/graph3d/test/VectoForceLayout.wasm.test.ts:6` streaming/sync enablement and the spaced copies at `VectoForceLayout.ts:618`).

Build is the same as boss 08's trap: `crates/vectojs-force-rs/build.sh` with `RUSTFLAGS="-C target-cpu=generic -C target-feature=+simd128 -C linker=rust-lld"`; bare `cargo build --target wasm32-unknown-unknown` leaks `~/.cargo/config.toml` host flags and breaks the link.

## 8. Benchmark methodology — what is quotable

`benchmarks/graph-layout/entry.ts:1` header is the authority. Only `benchmarks/run-browsers.sh` (a `bun runner/cli.ts` wrapper at `benchmarks/run-browsers.sh:4`) produces quotable numbers — it drives a **real headed browser on a dedicated Hyprland workspace, focused window, real GPU** (per workspace `AGENTS.md` benchmark contract). `benchmarks/debug-page.ts` and `scripts/benchmark.ts` are headless (`--disable-gpu`) — a regression tripwire and a debugging aid, not a quote.

### 8.1 Matrix, budgeting, and what settles mean

The **budgeted defaults** (CTX-0517, 2026-08-26 — `entry.ts:4`) are:

- `COUNTS = 100,1000,3000` (`entry.ts:48` — dropped 500 as the log-neighbour of 1000; 3000 retained as the `#559` baseline)
- `TICKS = 30` regular per-tick samples (`entry.ts:49`)
- `TRIALS = 3` (`entry.ts:50` — the `#559` baseline protocol; suite-level repetition via `run-browsers.sh --iterations`)
- `SETTLE_CAP = 120` (`entry.ts:51` — first 120 post-append ticks, not natural convergence at ~285–300 ticks; `settleCappedTrials == TRIALS` by design, per 2026-08-25 sweep)
- `APPEND_NODES = 50` (`entry.ts:57`), `WARMUP_TICKS = 5` (`entry.ts:58`), `POST_TOPOLOGY_ALPHA = 1` (`entry.ts:59`)

The **old defaults** (`counts 100,500,1000,3000 × 2 workloads × 4 arms × 6 trials × cap 500`) projected to >1500 s/engine because each settle tick pays a ~4 ms timer-clamped `setTimeout(0)` yield (`entry.ts:301` `yieldToPaint`) and settles ran to ~300 ticks — now ~150 s headless Chrome per envelope (`entry.ts:25`).

**Workloads** are `star-hub` and `mixed-sparse` (`entry.ts:61`), with graphs built at `entry.ts:226` / `entry.ts:252` (positions seeded on a `sqrt`-spiral to avoid stacking) and append payloads adding 50 nodes + hub or preferential+random links.

**Arms** are four (`entry.ts:599`):

| arm               | dims | impl               | `appendMode`       | construction                                                                                                                                                                                                                      |
| ----------------- | ---- | ------------------ | ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `d3-force-3d`     | 3    | `D3ForceLayout`    | `setGraph-rebuild` | `new D3ForceLayout()`                                                                                                                                                                                                             |
| `vecto-force`     | 3    | `VectoForceLayout` | `setGraph-rebuild` | `new VectoForceLayout()`                                                                                                                                                                                                          |
| `d3-force-2d`     | 2    | d3-force in-page   | `appendGraph`      | `D3Force2DLayout` at `entry.ts:78` (charge `300`, `distanceMax 450`, `theta 0.9`, collide `radius+14`)                                                                                                                            |
| `force-layout-2d` | 2    | `ForceLayout2D`    | `appendGraph`      | `new ForceLayout2D({repulsion: charge, collisionRadius: radius+14, linkDistance accessor, linkStrength 0.42, center 0.016, velocityDecay 0.64, alphaDecay 0.024, repulsionDistanceMax 450, theta 0.9, seed 7})` at `entry.ts:625` |

Arm order is **deterministically rotated** per `(workloadIndex, countIndex)` (`entry.ts:647` `rotatedArms`) so engine/agent ordering cannot bias a count.

### 8.2 What is measured

Three observables per arm/workload/count, all behind `performance.now()` and `setTimeout(0)` task boundaries so long-task entries don't merge (`entry.ts:330` `captureLongTasks` via `PerformanceObserver 'longtask'`):

- **`benchTicks`** (`entry.ts:501`) — `TICKS` regular `step()` calls from a fresh reheated graph: `median/p95/max` (`entry.ts:292` `summarize` via `median`/`percentile` from `_shared/stats.ts`).
- **`benchAppend`** (`entry.ts:526`) — topology mutation only (cloned payloads prebuilt at `entry.ts:346` `prepareAppendPayloads` so cloning never favours `appendGraph`); then explicit `reheat(POST_TOPOLOGY_ALPHA)` before every first post-append tick and every settling loop (`entry.ts:559`). Returns `append` median/p95, `firstTick` median/p95, `settleTotal` median/p95 over up to `SETTLE_CAP` ticks, `settleTicks` median/p95, `settleCappedTrials`, and `maxStepMs` (maximum single `step()` across all phases, `entry.ts:679`).
- **`observeLiveAppendMemory`** (`entry.ts:398`) — one dedicated warmed live layout retained across immediate before/after readings, payload creation and disposal _outside_ the delta (`entry.ts:415` comment). Prefers `performance.measureUserAgentSpecificMemory` (`entry.ts:444`, bounded by `UA_MEMORY_TIMEOUT_MS = 1250` at `entry.ts:55` via `entry.ts:353` `readUaMemoryWithTimeout`); a single timeout failure disables further UA reads for the run (`entry.ts:454` `uaMemoryDisabledReason`); retries the complete observation with fresh layout on the heap fallback (`performance.memory.usedJSHeapSize` at `entry.ts:465`). Both are **noisy observations, not retained-memory or backend-selection evidence** (`entry.ts:740` caveats). Unsupported is reported as `status: 'unsupported'` with reason.

Also reported: `longTaskMaxDurationMs` per long-task capture (`entry.ts:678`), counted only when the `longtask` interval covers a measured `[started,ended]` (`entry.ts:326` `include`).

### 8.3 Headed-runner contract

Measured 2026-08-02, the 240 Hz panel is Hyprland `eDP-1 2560x1600` scale 1.6. Three cadence traps invalidate any figure silently: unfocused Chrome falls to ~60 Hz, Firefox needs `layout.frame_rate` and is 60 Hz by default even when focused (hand-driven Firefox is wrong by 4×), and a `refreshHz` of exactly 250 is a median artifact on a 240 Hz panel. The harness (`benchmarks/_shared/server.ts`, `runner.ts`, `loaf.ts`) does `validateEnvironment`, starvation detection, cross-run aggregation, and carries commit + host CPU/GPU/driver (a page cannot see these). Each benchmark owns only `entry.ts` + three-line `build.ts` (`benchmarks/graph-layout/build.ts:11` delegating to `_shared/build.ts`); the server/bundler live in `_shared/` — do not duplicate them.

**Never hardcode a refresh rate** — call `calibrateRefreshRate()` and report `refreshHz` beside any per-frame figure. Quote both engines (V8 and SpiderMonkey diverge).

### 8.4 Baseline snapshots

The **complete N=7 baseline** at 500 nodes (`benchmarks/graph-layout/README.md:44`, run `20260820T135641Z-1a6d54`, Chrome `240.04 Hz` / Firefox `240.64 Hz`) is the last fully-iterated complete matrix under the headed budget (the 1000-node and 3000-node full matrices timed out at `entry.ts` defaults — see `README.md:11` and `README.md:28`). Representative settle medians (500 nodes, `TICKS 30`, `TRIALS 1`, `SETTLE_CAP 500`, both workloads) are in that README; the reduced budgeted defaults above supersede it for per-engine cost (~150 s). Keep results under `benchmarks/graph-layout/results/` (gitignored) and identify runs by the runner's history ID, not by copying lines.

## 9. d3-force migration, interaction, and culling

**Migrating from d3-force** (`d3-force`/`d3-force-3d`) to `ForceLayout2D`/`VectoForceLayout` is not a rename. The bench caveat at `benchmarks/graph-layout/entry.ts:745` is load-bearing: "The 2D rows … compare different force laws: `ForceLayout2D` uses inverse-square repulsion and equal free/free collision shares; `d3-force` uses inverse-distance repulsion and radius-squared collision shares. Treat ratios as implementation-level workload comparisons, not equation-equivalent kernel measurements."

Concrete deltas to translate:

- **Repulsion law:** `ForceLayout2D` is `−charge / d³ * (dx,dy)` (`BarnesHutQuadtree.ts:134` `factor = -charge*invD/d²`), i.e. inverse-square in force magnitude; d3's `forceManyBody` is inverse-distance (`strength / d`). Absolute numbers are not comparable — re-tune `repulsion`/`chargeStrength` rather than copying them.
- **Cutoff semantics:** `ForceLayout2D` tests the _aggregate's_ center of charge against `repulsionDistanceMax` (`BarnesHutQuadtree.ts:98` `nearestDistanceSquared` + `maxDistanceSquared` pre-test), matching d3's many-body cutoff; with `theta: 0` the cutoff is exact per-point (`types.ts:59` doc). `Infinity`/non-finite disables it — `0` disables it _silently_ via early-return, so `finiteOr` at `ForceLayout2D.ts:91` maps any non-positive to `Infinity`.
- **Link identity:** `ForceLayout2D` deduplicates on directed `(source,target,id)` via `linkIdentity` (`ForceLayout2D.ts:826`) and throws on dangling/self links before mutating; d3 keeps raw string ids on the link objects and the editor's `duplicate-link` guard is even stricter (divergence note at `ForceLayout2D.ts:387`). When migrating a persisted graph, normalise `id` fields first.
- **Pin addressing:** covered in §6 — `ForceLayout2D` by `NodeId`, graph3d's `GraphLayout` by index. Drag-to-pin handlers that capture an index must re-resolve after `removeNodes` on the 2D side.
- **Theta:** range and effect are identical — `0` = exact `O(N²)`, larger = faster/looser (`types.ts:57`, `VectoForceLayout.ts:28`). The default `0.9` is tuned to feel similar across stacks but is not bit-identical between quadtree and octree.

**Interaction and visibility** are outside the physics tick but expensive at scale. `packages/graph3d/src/GraphInteraction.ts:1` (`GraphInteraction`) maps Three.js raycaster hits to `nodeIndex` for hover/select/drag-to-pin, and does the usual hover debounce; `Graph3D.ts:1` (`Graph3D`) instanced-renders the graph and culls off-screen. Neither replaces the layout — they consume `positions` after `step()`. At 3000 nodes the renderer, not the layout, is often the frame bottleneck (`benchmarks/graph3d-frame/entry.ts:1` frame-cost harness vs `benchmarks/graph-layout/entry.ts:1` physics matrix — keep the two harnesses distinct). For canvas `Scene` hosts (not Three.js), `packages/core/src/tree/Scene.ts:1` culling does the same work; graph-layout itself never culls.

## 10. Tuning and traps

Pins differ by stack (`ForceLayout2D` by ID, graph3d by index — `ForceLayout2D.ts:387`); translate when porting. `repulsionDistanceMax = 0` disables repulsion entirely (`BarnesHutQuadtree.ts:77` early-return) — non-finite is the intended "no cutoff" (`ForceLayout2D.ts:91`). `alphaDecay = 0` falls back to `0.0228` or the settle loop never terminates (`ForceLayout2D.ts:95`). A non-finite or host-leaked `RUSTFLAGS` breaks the WASM build or its bit-parity (`fma` on a tuned CPU, `crates/vectojs-force-rs/build.sh:8`); use `just wasm`. The tier-span sizing bug (`BarnesHutQuadtree.ts:237`) — sizing offset tables by point count instead of tier span — silently drops counting-sort increments when radii span ~280 tiers of `f32`. The view-detach after `force_init` growth (`force-backend.ts:37` `viewsStale`) must re-validate typed-array views after every `force_step`.

Additional landmines found during this research:

- **Negative repulsion in 2D is clamped, not supported.** `ForceLayout2D` clamps `repulsion` to `>=0` at `ForceLayout2D.ts:629`/`ForceLayout2D.ts:761` and `BarnesHutQuadtree.ts:109` skips `charge<=0` subtrees — the `finalize` guard at `BarnesHutQuadtree.ts:507` would otherwise misplace the center of charge for attractive nodes. D3's negative (attractive) charge has no equivalent here; revisit both guards before allowing it.
- **Link `id` vs endpoint addressing.** `removeLinks` lazily builds a `linksByIdKey` map only when a bare `LinkId` appears (`ForceLayout2D.ts:270`), replacing the previous `O(items×L)` scan per item. Passing a full `GraphLink` object with a different `id` than stored will not match — identity is the serialised triple, not object identity.
- **`positions` view aliasing.** `refreshPositionView` returns a `subarray` over the _same_ `ArrayBuffer` (`ForceLayout2D.ts:749`). Holding a reference across `ensureNodeCapacity` or `removeNodes` (which `resize` the buffer at `ForceLayout2D.ts:857`) leaves a detached view of length 0. Re-read `layout.positions` after every mutation.
- **No `forge/baselines/graph-layout*` yet.** `benchmarks/graph-layout/results/` is gitignored and there is no checked-in `forge/baselines/graph-layout.json` — every claim in §8 must be re-measured on the quoting host. The 500-node N=7 finding in `benchmarks/graph-layout/README.md:44` is a host-specific snapshot, not a portable baseline file.
- **`crates/vectojs-force-rs` has exactly one build artifact.** `build.sh` emits `packages/graph3d/src/wasm/vectojs_force.wasm` and `tsup` copies it to `dist/wasm/` (`packages/graph3d/tsup.config.ts:40`). There is never a second crate or a shared WASM package — until a third consumer appears (`DEC-0081` at `force-backend.ts:12`), keep it local.
- **Differential oracle discipline.** The 3D path's `VectoForceLayout` JS octree is the _permanent_ oracle; the Rust kernel at `crates/vectojs-force-rs/src/lib.rs:1` must stay bit-identical on `f64` accumulation (positions `f32` on both sides). Grep for `jitter_for`/`jitterFor`/`mulberry32` across `VectoForceLayout.ts:606`, `BarnesHutQuadtree.ts:610`, `lib.rs:83` — any change to one that does not land in the other is a diff failure. The `measurePhases` opt-in (`VectoForceLayout.ts:45`) keeps the oracle measurable without paying `performance.now()` in prod.

When adding a new force, write the JS oracle first (`VectoForceLayout.ts:232` `tick` structure), keep op order and `Math.min/Math.max` NaN semantics (see `BarnesHutQuadtree.ts:632` `distanceToCellSquared` total-order comment), and gate the WASM path behind `measurePhases` (`VectoForceLayout.ts:45` opt-in `tickPhases: [octree, force, link, integrate]` wall-ms) so the hot path pays nothing when profiling is off.

## 11. Tests, differential oracles, and how things have actually broken

Three test suites cover the 2D side (`packages/graph-layout/test/BarnesHutQuadtree.test.ts:1` quadtree approx vs exact, `packages/graph-layout/test/ForceLayout2D.test.ts:1` `setGraph`/`appendGraph`/`removeNodes`/`removeLinks`/`updateLinks`/pins/alpha, `packages/graph-layout/test/ForceLayout2D.linkMutations.test.ts:1` dedup/degree bias/link shares). The 3D side adds `packages/graph3d/test/VectoForceLayout.wasm.test.ts:1` (JS vs WASM bit parity: streaming, sync, fallback on bad URL at `VectoForceLayout.wasm.test.ts:123` `file:///nonexistent` → `false`).

What they guard and what has bitten before — read these as the review checklist:

- **Sanitize before build.** A `NaN` position left in `positionStorage` poisons the quadtree bounds (`minX = NaN` → `size = NaN`). `sanitizeState` at `ForceLayout2D.ts:752` `toF32`+pin overwrite exists because this happened once with a caller-supplied `x: NaN` from a destructured JSON. Never remove that loop.
- **Zero-distance floor.** Without the `1e-6` floor at `BarnesHutQuadtree.ts:132`/`BarnesHutQuadtree.ts:154` and `VectoForceLayout.ts:727`, two coincident points in the same cell produce `factor = -m/0 = ±Infinity` → `NaN` velocities that infect every later tick. The deterministic angle at `BarnesHutQuadtree.ts:610`/`ForceLayout2D.ts:878` makes the push repeatable.
- **Pinned share leak.** Forgetting the `springShare` fallback when one endpoint is pinned (fixed `0` or `1` in `ForceLayout2D.ts:846` / `BarnesHutQuadtree.ts:406`) leaves a pinned node to be dragged by the other endpoint's velocity. History: early 3D pins jittered because link springs still integrated the pinned coordinate.
- **Alpha never reaches min.** Passing `alphaDecay: 0` kept `alpha` at `1` forever — the host loop `while(layout.step())` never terminated. The guard at `ForceLayout2D.ts:95` / `VectoForceLayout.ts:117` mapping `0` → `0.0228` exists from a live Incident where a computed option produced `0`.
- **Memory observation misread.** The `liveAppendMemoryObservation` numbers in `entry.ts:398` are _whole-agent_ observations with GC noise (`entry.ts:449` caveat); treating them as per-backend retained heap is the most common misquote of the graph benchmarks. The run also disables UA-specific reads after one timeout (`entry.ts:454`) and retries on `usedJSHeapSize` — comparing a run that switched sources mid-matrix against one that didn't is not valid.

Complexity summary for reviewers:

| phase             | 2D                                                                | 3D                                  | where                                                 |
| ----------------- | ----------------------------------------------------------------- | ----------------------------------- | ----------------------------------------------------- |
| tree build        | O(N log N) quadtree                                               | O(N log N) octree                   | `BarnesHutQuadtree.ts:36` / `VectoForceLayout.ts:414` |
| repulsion         | O(N log N) average, O(N²) worst with `theta=0`                    | same                                | `ForceLayout2D.ts:484` / `VectoForceLayout.ts:259`    |
| links             | O(L)                                                              | O(L)                                | `ForceLayout2D.ts:499` / `VectoForceLayout.ts:274`    |
| collision         | O(N) average via tiered grid; O(N²) without tiers on skewed radii | —                                   | `BarnesHutQuadtree.ts:172`                            |
| memory per layout | ~6×N f32 + links + tree ~4N nodes                                 | ~7×N f32 + links + octree ~8N nodes | `ForceLayout2D.ts:672` / `VectoForceLayout.ts:445`    |

## 12. Reproducibility — commands you can quote

```bash
# Build the WASM force kernel (required before any WASM path):
just wasm                         # or crates/vectojs-force-rs/build.sh
# Optional: verify the JS oracle alone (no Rust needed):
just test-pkg graph-layout && just test-pkg graph3d

# Headed physics matrix — the quotable path (needs Hyprland + headed Chrome/Firefox):
./benchmarks/run-browsers.sh graph-layout 8272 --viewport 1280x720 \
  --param counts=100,1000,3000 --param ticks=30 --param trials=3 \
  --param settleCap=120 chrome firefox
# Full-convergence variant (reproduces the old 500-tick settle, budgeted explicitly):
./benchmarks/run-browsers.sh graph-layout 8273 --viewport 1280x720 \
  --param counts=100,500,1000,3000 --param ticks=30 --param trials=6 \
  --param settleCap=500 chrome firefox   # expect >1500 s — budget accordingly

# 3D frame cost (renderer, not physics — don't conflate):
./benchmarks/run-browsers.sh graph3d-frame 8274 --viewport 1280x720 chrome firefox
```

Report `refreshHz` from `calibrateRefreshRate()`, both engines, commit SHA, and host CPU/GPU/driver (the page cannot see these — the harness at `benchmarks/_shared/server.ts:1` captures them). Keep raw JSON under `benchmarks/graph-layout/results/` (gitignored) and cite its history ID, not pasted medians.

## Appendix — where to read next

| goal                               | start                                                                                | then                                                                                         |
| ---------------------------------- | ------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| tune a 2D layout for a new dataset | `packages/graph-layout/src/types.ts:42` + `ForceLayout2D.ts:79` constructor defaults | `ForceLayout2D.ts:480` tick phases → `BarnesHutQuadtree.ts:8` indices                        |
| add a new force (e.g. radial)      | `VectoForceLayout.ts:232` `tick` structure as template                               | `crates/vectojs-force-rs/src/lib.rs:10` scope note — only octree forces belong in the kernel |
| paginate a knowledge graph         | `knowledge-graph/src/KnowledgeGraphModel.ts:62` lifecycle                            | `FixedZLayout.ts:10` if you need a 2D projection of a 3D layout                              |
| quote a number                     | `benchmarks/graph-layout/entry.ts:1` header + `benchmarks/graph-layout/README.md:44` | `benchmarks/_shared/stats.ts:1` for `median`/`percentile` semantics                          |

---

_Up next: **Boss 12 — DevTools** (the runtime inspector that lets you point at a pixel and read back which entity owns it, and why). Back: **Boss 10 — Video Export** (deterministic fixed-step capture). Series: 00 Overview → 01 Selection → … → 11 Graph Layout (this doc) → 12 DevTools → 99 Synthesis._
