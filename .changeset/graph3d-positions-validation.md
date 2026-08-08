---
"@vectojs/graph3d": patch
---

fix(graph3d): skip Graph3D.applyPositions on an undersized positions array

`positions[i]` past the end of a `Float32Array` is `undefined`, not `0`, so a
`positions` array shorter than `nodeCount * 3` wrote NaN instance matrices and a
NaN bounding sphere. The NaN sphere makes frustum culling reject the whole
instanced mesh, so the graph blanked entirely rather than losing only the
missing tail.

`applyPositions` now validates `positions.length >= nodeCount * 3` up front and
returns without writing anything, so there is no half-applied frame. The warning
is latched (once per `setGraphData`) because this is a per-frame layout callback
— an unlatched `console.warn` would emit at the display refresh rate.

Unit test: `packages/graph3d/test/Graph3D.test.ts`
