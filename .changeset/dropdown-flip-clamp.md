---
'@vectojs/ui': patch
---

Flip and clamp the Dropdown menu at the viewport edges (#664)

The menu was placed unconditionally below the trigger, so a trigger docked
near the scene bottom opened a menu whose rows extended off-canvas and could
not be reached by pointer or keyboard. Placement now follows the base-Overlay
rule: flip above when there is no room below and more room above, then clamp
into view with a 4px inset.

Fixes #664
