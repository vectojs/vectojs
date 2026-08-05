---
'@vectojs/core': patch
---

Order the a11y projection region-major so a drag-selection cannot cross regions

`sortNormalElementsVisually()` banded **all** of `normalElements` — one flat array
for the whole scene — into rows by top edge and sorted each row by `left`. That is
correct for a screen reader and wrong for selection: a DOM `Selection` covers
everything between anchor and focus **in DOM order**, so regions laid out side by
side interleaved. Dragging through a transcript also selected the sidebar and a
floating perf panel whose rows happened to fall in the same row bands.

Measured on the reported geometry (sidebar column at `x=20`, body at `x=312`,
interleaved in `y`), the projected order was
`body-p1, sidebar-creations, body-p2, sidebar-built-on, body-p3` — a drag from the
first body paragraph to the last swept both sidebar headings.

Banding now runs **per region**, where a region is the nearest `clipChildren`
ancestor. `enforceA11yDomOrder`'s collect walk already has the entity in hand, so
the region is threaded down the walk for one comparison per node rather than an
ancestor walk per element. Each region occupies a contiguous DOM run, so a drag
stays inside it, while reading order *within* a region is byte-for-byte unchanged
and regions are emitted in the order the depth-first walk first reaches their
clipper — so a screen reader still meets them in the author's declared order.

A scene with no `clipChildren` ancestors is one implicit region and its order does
not change at all, which is why every existing ordering test still passes.
`ScrollView` already sets `clipChildren`, so scenes built from it get regions with
no code change; a scene that lays regions out as flat siblings has to mark its
clippers to opt in.
