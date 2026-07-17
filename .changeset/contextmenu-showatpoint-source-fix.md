---
'@vectojs/ui': patch
---

Fixed `ContextMenu.showAtPoint(x, y, source?)`: its override dropped the `source` arg entirely when forwarding to `Overlay.showAtPoint` (added in 1.10.0), and its own scene-resolution check (`this.scene`) ran before `source` could help — so a freshly-constructed `ContextMenu`'s first `showAtPoint(x, y, someEntity)` call still silently no-opped, the exact bug 1.10.0 was supposed to fix for every `Overlay` subclass. `Overlay._sceneFromSource` (the resolver `showAtPoint` uses) is now `protected` so subclasses that override `showAtPoint` share one resolution path instead of drifting out of sync with it.

Added a component conformance test suite (`packages/ui/test/ComponentConformance.test.ts`) covering every `@vectojs/ui` component against five checks: unique ids + independent event routing across instances, defined (non-silent-no-op) behavior for pre-mount API calls, `hasPendingAnimations()` reporting for any triggered animation, parent-resize tracking (or a documented exemption), and leak-free `destroy()`/`remove()`. This is what caught the `ContextMenu` regression above.
