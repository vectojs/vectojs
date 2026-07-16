---
'@vectojs/core': patch
---

Match `DOMPortalEntity.add()` to the variadic `Entity.add()` signature so
multi-child calls hit the same leaf-node warning instead of a narrower
override.
