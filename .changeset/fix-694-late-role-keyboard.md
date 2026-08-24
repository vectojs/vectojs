---
'@vectojs/core': patch
---

core: interactive a11y roles assigned after element creation now receive the synthetic Enter/Space activation handler (#694). The handler was installed only in syncA11y's creation pass while tabindex was refreshed every pass, so late-roled controls were Tab-reachable but keyboard-dead (WCAG 4.1.2).
