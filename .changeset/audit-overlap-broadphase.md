---
"@vectojs/devtools": patch
---

Broad-phase the layout audit's sibling-overlap check. `auditTree` compared every
sized sibling against every other one — O(k²) intersection tests _and_ O(k²)
`worldBox()` calls, since the inner loop recomputed the other box each time — so
auditing a long list or a wide table was quadratic in exactly the thing you most
want to audit. Boxes are now computed once and candidates filtered through a
`SpatialHashGrid` (the same broad phase the engine already uses for hit testing;
re-exported by `@vectojs/core`, so no new dependency).

Findings are unchanged — same pairs, same tolerance, same `ignoreOverlap`
handling — verified against an exhaustive all-pairs reference over dense grids,
wildly-varying box sizes, and sparse long lists.

Measured on one parent with N non-overlapping rows (median of 7,
`forge/baselines/devtools-audit-overlap-broadphase.json`): 200 rows 5.35 → 0.82ms
(6.5×), 1000 rows 75.8 → 1.7ms (44×), 4000 rows **1280.7 → 7.4ms (173×)**. This is
a dev-only path, so it buys tooling responsiveness rather than app frame time.
