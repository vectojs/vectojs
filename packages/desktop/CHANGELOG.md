# @vectojs/desktop

## 0.2.0

### Minor Changes

- 149fbf3: Initial `@vectojs/desktop` WebOS shell (Plasma-aligned): DesktopShell, KWin-like windows (min/max/close/resize), taskbar + Kickoff start menu, multi-display work areas, shortcut router, VFS + MemoryVfs, single/multiple instance policy, onDemand a11y.

### Patch Changes

- a5315da: Desktop review (CTX-0368): VectoJSEvent local/scene coords for window chrome; restack without Entity.remove; release a11y on blur; start-menu height; syncLayoutToScene; pointercancel ends drag. Button.setLabel remeasures content-driven width.
- Updated dependencies [a5315da]
  - @vectojs/ui@2.16.7
