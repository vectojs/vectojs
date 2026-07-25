---
"@vectojs/core": patch
---

`Scene.findEntityAt` (its JS hit-test walk, the permanent fallback) now respects visibility and pointer-input gating that the previous "run `isPointInside` on every node" walk ignored:

- **Invisible subtrees**: a node (and its whole subtree) with `opacity <= 0` is no longer a hit target — it isn't drawn, so it shouldn't intercept pointer input.
- **Clipping**: a descendant that falls outside a `clipChildren` ancestor's world box is no longer hit, even though its own `isPointInside` returns true — matching what's actually visible/clickable on screen.
- **Disabled / non-interactive**: a node whose `getA11yAttributes()` reports `disabled: true` or `pointerEvents: 'none'` is skipped as a target (its children are still walked, so a transparent container can hold hittable descendants).

Top-most-wins ordering is unchanged. (The WASM hit-grid path indexes geometry only; applying the same clip/opacity/disabled gating there is a tracked follow-up — the JS walk is the correctness reference.)
