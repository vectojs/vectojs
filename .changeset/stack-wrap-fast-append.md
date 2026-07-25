---
"@vectojs/ui": patch
---

Make wrapping `Stack` (and `Flow`) appends O(1) instead of O(children). `Stack.add()` already had an O(1) fast path for the non-wrap, start-aligned case, but a **wrapping** stack fell back to a full `layout()` on every `add()` — so building a wrapping `Flow` one child at a time (a streaming list of chips/tags) cost O(children²) total. There is now an O(1) wrap fast-append that places each new child at the end of the current line (or the start of a new one) using persisted last-line state, recomputed at the end of each full `layout()` and updated per append. It runs under the same invariants as the existing fast path (`align: 'start'`, not immediately after a `remove()`) — start alignment is what makes it safe, since a later, cross-larger child on a line never shifts an already-placed sibling. Behavior is identical to a full re-layout (unit-tested for equivalence across both directions and a mid-stream `layout()`).

Real-hardware benchmark (`benchmarks/stack-wrap`, Chrome 150 + Firefox 153): fast-append total build time stays ~0.5–1.4 ms as the child count grows, while the old full-layout-per-add grows quadratically — at 4000 children, 195 ms → 0.9 ms on Chrome (**213×**) and 173 ms → 1.4 ms on Firefox (**120×**).
