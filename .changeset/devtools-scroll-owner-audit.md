---
'@vectojs/devtools': patch
---

`auditTree`: recognize virtualized `Table` body clips as scrollable.

The default scroll-owner list now uses the exported `Table` name instead of the stale `Tree` name, and clipping children inherit a configured direct parent's vertical-scroll exemption.
