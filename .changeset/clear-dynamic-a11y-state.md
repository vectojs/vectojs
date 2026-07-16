---
'@vectojs/core': patch
---

Clear stale optional native and ARIA state from existing accessibility shadow
elements when an entity stops returning that attribute. Dynamic disabled,
checked, expanded, selected, relationship, range, role, and label state now
tracks the current VMT contract instead of retaining a previous frame's value.
