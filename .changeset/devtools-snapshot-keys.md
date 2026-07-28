---
'@vectojs/devtools': minor
'@vectojs/core': patch
---

Pair snapshot siblings by a stable key instead of by child index.

`captureSnapshot` now records a position-independent `key` per node, preferring
the component's declared `devtoolsKey` and falling back to its accessible label.
`diffSnapshots` pairs by that key when every key on a level is unique, and
addresses keyed nodes as `root > Row{k:row-42}` so the path survives reordering.

The gain is attribution, not diff size. Measured on a 200-row list with distinct
row text, a head insertion produces 201 diffs either way — the rows really did
move — but unkeyed, all 200 additionally claim their text was rewritten, because
each row is compared against its neighbour, and the inserted row is reported at
the tail index rather than the head.

Drawn text is deliberately not a key candidate: keying on content would turn a
text edit into a removal plus an addition and lose the from/to. Colliding keys on
a level fall back to index pairing rather than pairing arbitrarily, and the path
falls back with them so a node is never addressed ambiguously.
