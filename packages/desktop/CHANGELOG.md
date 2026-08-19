# @vectojs/desktop

## 0.6.0

### Minor Changes

- bd67ec0: Add optional SVG app icons and stable vector icons for Start menu, taskbar, and window commands.

## 0.5.0

### Minor Changes

- f23709d: `AppDefinition` gains optional `minWidth`/`minHeight`: the effective window floor becomes `max(theme-min, app-min)`, applied on open, `setGeometry`, and edge resize — so tiling and snapping never shrink a window below its content.
- 54f060d: Taskbar window entries now show title-only labels (the app-icon prefix is dropped), use the `Segoe UI` font stack, truncate at 20 characters, and use tighter padding/radius with a wider minimum width.

## 0.4.0

### Minor Changes

- a64b410: Expose `windowManager` on `AppContext` so apps can enumerate, focus, and close
  windows (enables a task-manager-style window list and snap/tiling demos in
  forge apps).

## 0.3.1

### Patch Changes

- Fix the published package manifest: framework deps were shipped in `dependencies` as `workspace:*`, making every published tarball uninstallable for external consumers. They now live in `peerDependencies` with real semver ranges (`core >=1.36.0 <2.0.0`, `styles >=0.3.2 <1.0.0`, `ui >=2.16.7 <3.0.0`), with `workspace:*` dev-time entries in `devDependencies` only.

## 0.3.0

### Minor Changes

- 1025591: Desktop shell polish pass: taskbar window entries update in place instead of being destroyed/recreated on every WM event; the taskbar clock only repaints when the displayed minute changes; visible corner resize grips and keyboard window move (tab to the titlebar handle, arrow keys, Shift = 1px) on `DesktopWindow`; consolidated `DesktopShell.resize`/`syncLayoutToScene` into one bounds-aware path (`DisplayLayout.resize` and `Taskbar.resize` removed); shared `startMenuHeight` helper; shared `DEFAULT_WINDOW_WIDTH`/`DEFAULT_WINDOW_HEIGHT` constants; `DesktopShell.taskbar` is now public; `ShortcutRouter` ignores key-repeat events.

### Patch Changes

- 6e99bea: Fix window interaction and shell lifecycle: frame Card no longer steals hits; chrome buttons stopPropagation; client content fills on resize; app defaultWidth/Height; Start button label; transfer focus on window minimize; re-fill workArea on maximize resize; Escape key dismissal of StartMenu; clientToScene outside pointer mapping.
- 1e14de8: Add dynamic theme switching API (`DesktopShell.setTheme`, `WindowManager.setChrome`, `DesktopWindow.updateChrome`), fix live wallpaper viewport resizing, support system tray digital clock, and decouple `desktop-start-fg` tokens.

## 0.2.0

### Minor Changes

- 149fbf3: Initial `@vectojs/desktop` WebOS shell (Plasma-aligned): DesktopShell, KWin-like windows (min/max/close/resize), taskbar + Kickoff start menu, multi-display work areas, shortcut router, VFS + MemoryVfs, single/multiple instance policy, onDemand a11y.

### Patch Changes

- a5315da: Desktop review (CTX-0368): VectoJSEvent local/scene coords for window chrome; restack without Entity.remove; release a11y on blur; start-menu height; syncLayoutToScene; pointercancel ends drag. Button.setLabel remeasures content-driven width.
- Updated dependencies [a5315da]
  - @vectojs/ui@2.16.7
