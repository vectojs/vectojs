---
'@vectojs/layout': patch
---

`cancelLayout` now purges only the cancelled entity's own `id-<seq>` pending entries (numeric suffix required) instead of every key sharing a string prefix, so cancelling one entity can no longer cancel another whose id extends it across a hyphen boundary (`text` vs `text-1`, `a-b` vs `a-b-c`).
