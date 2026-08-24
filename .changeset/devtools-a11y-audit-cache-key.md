---
'@vectojs/devtools': patch
---

fix(devtools): a11y audit cache no longer goes stale on property-only changes (#705)

The A11y tab's findings cache keyed only on `structureVersion`, which moves
exclusively on add/remove/reparent. Audit inputs include non-structural state —
accessible labels, `disabled`, opacity (the disabled-divergence heuristic), tabIndex and world bounds (the focusable-but-clipped check) — so a relabel, dim
or scroll changed the audit result while the version stayed put, and the tab
re-showed a stale finding list indefinitely. The cache key now also carries the
inspected entity (highlight reuse means switching it moves no version) and a
staleness TTL bounded by the reconcile interval, so drift surfaces within ~3s
instead of never.
