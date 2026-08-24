---
'@vectojs/core': patch
---

core: the a11y DOM-order pass now restores focus when a moved SUBTREE contains it (#698). The refocus guard only matched the moved element itself, so reordering a composite container deep-blurred whichever descendant held focus; the exact focused element is now captured before the move and restored after.
