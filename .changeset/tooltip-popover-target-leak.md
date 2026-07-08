---
'@vectojs/ui': patch
---

Fix `Tooltip` and `Popover` leaking a listener on their target entity: both registered a `hover`/`click` closure directly on the caller-supplied `target` without ever removing it, so destroying a `Tooltip`/`Popover` while its target stayed alive left the target holding a reference to the dead instance — a later hover/click would resurrect the destroyed overlay back into the scene tree instead of being a no-op. Both now store the handler and detach it in `destroy()`.
