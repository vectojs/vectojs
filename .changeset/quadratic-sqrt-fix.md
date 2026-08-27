---
"@vectojs/tex": patch
---

Fix quadratic formula sqrt radicand truncated and misplaced (#825).

ROW_ALIGN for sqrt was centered instead of left, and hide-tail clip was sized to min-width only; wide radicand `b^2 - 4ac` rendered as `b²√4ac` with truncated vinculum.
