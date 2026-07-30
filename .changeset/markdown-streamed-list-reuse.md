---
"@vectojs/markdown": patch
---

Reuse a streamed list's `Stack` instead of rebuilding every item.

A `list` token carries **every** item, so a list streamed to N items rebuilt
1+2+…+N `RichText` instances — Θ(N²). Measured before this change, a 32-item
list cost 528 constructions against 32 for the same list built once. The
reconciler now appends new items and rewrites only a growing tail item in place,
guarded so any state a stream cannot produce (a shrinking list, an edit to a
retained item, a tight→loose transition, a change of `ordered`/`start`) falls
back to the existing rebuild.

Real Chrome and Firefox, median of 7 trials, two runs per arm: reconcile for a
growing list **70.7 → 20.8 ms (Chrome, −71%)** and **39.3 → 12.0 ms (Firefox,
−66%)**, with total append+render **−37%** / **−17%**. The `mixed` shape also
improves −31% / −28%, because a list followed by more prose is a trailing token
that used to be rebuilt on every subsequent chunk.

Also fixes a dead indent in the list renderer: `itemRt.x = 12` was overwritten by
`Stack`'s append fast path (which assigns `x = 0` for a vertical stack and treats
`x`/`y` as layout-controlled), so list items were never indented — while
`maxWidth` still reserved 24px for that indent, shrinking the wrap width for no
reason. Items now use the full available width. A list nested in a blockquote is
still indented by the quote's own wrapper.
