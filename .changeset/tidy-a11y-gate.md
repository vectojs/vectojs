---
'@vectojs/core': patch
---

Consolidate the a11y projection gate behind a single predicate.

`interactive && (width > 0 || a11yFullViewport)` was inlined verbatim at four
sites — `syncA11y` (create/update), `enforceA11yDomOrder` (which ids survive
pruning), `getA11yTree` (the public snapshot) and `render` (reading-order and
z-index assignment). Four copies of one rule is a standing correctness hazard: if
any drifts, elements either leak (created but never marked active, so pruned and
rebuilt every frame) or vanish from the semantic tree while still in the DOM. All
four now call `shouldProjectA11y(node)`.

The dev-mode leak warning counted with a *different*, approximate rule
(`interactive && width > 0`), which undercounts `a11yFullViewport` nodes —
projected at width 0 — and needed `+2` slack to avoid false positives. That slack
also hid genuine one- and two-element leaks. It now uses the same predicate and
compares exactly; its message says "projectable entities" rather than "interactive
entities", which is what it always meant.

No behaviour change for projection itself.
