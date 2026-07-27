---
'@vectojs/core': minor
'@vectojs/ui': minor
'@vectojs/devtools': patch
---

Show whether a property is a runtime override or computed by the parent's layout.

`Entity.getLayoutControlledProperties(child)` lets a container declare which of a
child's properties it recomputes. `Stack`, `Table`, `Tabs`, `RadioGroup`,
`ResizablePanel` and `ScrollView` implement it; `ScrollView` answers per child,
since it owns geometry on its internal wrapper but not on the children a caller
adds inside it.

DevTools marks those properties in the readout, names the owning container, and
shows a warning after an edit that will be reverted. The edit still applies —
nudging a `Stack` child to see what moves is legitimate; the useful behaviour is to
let it happen and explain why it did not stick.
