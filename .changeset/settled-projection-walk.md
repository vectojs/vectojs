---
"@vectojs/core": patch
---

Skip per-node geometry work in the content-projection walk once a document has
settled.

`syncContentProjection` already stopped early for an unchanged block, but only
after composing its world transform and running up to three
`projectionBoxVisible` ancestor walks. On a document that has stopped changing
that was the entire remaining per-frame cost, and it was paid forever. A gate
hoisted above that work now answers "nothing changed" from recorded scalars: the
content epoch, the font and viewport epochs, the entity's own local transform,
its box, and its parent's world transform. Since a world transform is the
parent's composed with those local components and nothing else, an unchanged pair
implies an unchanged world matrix — and so the tier, line band and visibility
derived from it are unchanged too.

Measured on real hardware at 10 000 resident blocks, a settled sync drops from
2.890 ms to 0.605 ms in Chrome and 2.870 ms to 0.760 ms in Firefox — 69% of a
4.16 ms frame at 240 Hz down to 14-18%.
