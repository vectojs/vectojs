---
'@vectojs/ui': patch
---

Give every ContextMenu backdrop a root-menu-scoped identity and dismiss it on pointerdown, while retaining semantic click activation. Rapid close-and-reopen cycles can no longer route an outside click to a stale backdrop owner and leave the replacement menu open.
