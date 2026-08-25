---
'@vectojs/devtools': patch
---

fix(devtools): a11y audit cache no longer re-walks the scene on selection changes (#785)

The cache key introduced for #705 also carried the inspected entity id, on the
theory that "selection changes must not serve another entity's findings". But
`auditA11y(host)` walks the whole scene and takes no selection argument, and its
only consumer applies the per-entity ▸ marker by comparing `finding.entityId` at
render time — findings are identical for every selection, so the extra key input
bought no correctness while paying one O(scene) audit walk per tree-row click,
the panel's primary interaction.

The key is now exactly the inputs that can change the result: the host's
structure version plus the staleness TTL. Property-only drift (labels, disabled,
opacity, tabIndex, world bounds) still surfaces within the reconcile-length TTL,
so the #705 semantics are unchanged.
