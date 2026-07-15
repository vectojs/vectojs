---
'@vectojs/graph3d': minor
---

Add node picking and drag-to-pin, so interactive 3D graphs no longer have to hand-roll raycasting against the instanced node mesh.

- `Graph3D.pickNode(raycaster)` — hit-test the node cloud with a caller-configured `THREE.Raycaster` and get back the struck node's index (aligned with `GraphData.nodes`), or `null` on a miss. Only the instanced node mesh is tested; links are never picked.
- `Graph3D.getNodePosition(index, target)` — read a node's current world position (as last written by `applyPositions`) straight from its instance matrix into `target`, or `null` for an out-of-range index.
- `GraphLayout.pinNode`/`unpinNode`/`reheat` — optional runtime pin controls on the layout contract. `D3ForceLayout` implements them over d3-force's `fx`/`fy`/`fz`, letting a node be clamped to a live position and the simulation reheated to settle around it.
- `GraphInteraction` — a small pointer-events helper that turns raw `pointermove`/`pointerdown`/`pointerup` over a `Graph3D` into `onHover`/`onSelect` and drag-to-pin (`onDragStart`/`onDrag`/`onDragEnd`), with a `setControlsEnabled` hook so the host can suspend its `OrbitControls` during a drag. Drag is feature-detected: without a pin-capable layout, presses fall back to select. It owns only its pointer listeners — no scene, render loop, or controls.

All additive and backward-compatible; the existing `Graph3D`/`D3ForceLayout`/`GraphLayout` surface is unchanged.
