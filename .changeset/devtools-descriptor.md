---
'@vectojs/core': minor
'@vectojs/ui': minor
'@vectojs/markdown': minor
'@vectojs/devtools': minor
---

Add the `getDevtoolsDescriptor()` protocol: entities describe their own debug
surface, so DevTools needs no table of component types.

`Entity.getDevtoolsDescriptor()` returns `null` by default. `VirtualList`,
`ScrollView`, `Slider`, `Input` and `Markdown` implement it, exposing state a
generic inspector cannot reach — visible range and pool/measurement counts,
spring position versus target, normalised thumb position, selection offsets, and
streaming token reuse ratio.

`inspectEntity()` carries the descriptor, and the panel's Inspect tab renders it
below the generic properties (20 rows, up from 8). Read-only fields are marked so
an edit that would be reverted is not invited.
