---
'@vectojs/devtools': patch
---

fix(devtools): tree label refresh reaches the filtered view (#786)

`refresh()`'s version-unchanged fast path rewrote labels on
`this.allNodes` — the original node objects. With a filter active,
`applyFilterToTree` hands the Tree shallow prune copies (`{...node}`),
and the Tree's rows render `row.node.label` from those copies, so the
#757 per-tick geometry refresh wrote to objects nothing displayed:
animated/moved entities kept the coordinates of the last rebuild or
filter edit for as long as the filter stayed on.

The panel now retains the pruned copies and runs the same in-place
label rewrite over them (still no `setNodes` churn, so expansion state
survives ticks). Clearing the filter keeps handing the originals.
