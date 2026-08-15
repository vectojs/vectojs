---
'@vectojs/desktop': minor
---

Desktop shell polish pass: taskbar window entries update in place instead of being destroyed/recreated on every WM event; the taskbar clock only repaints when the displayed minute changes; visible corner resize grips and keyboard window move (tab to the titlebar handle, arrow keys, Shift = 1px) on `DesktopWindow`; consolidated `DesktopShell.resize`/`syncLayoutToScene` into one bounds-aware path (`DisplayLayout.resize` and `Taskbar.resize` removed); shared `startMenuHeight` helper; shared `DEFAULT_WINDOW_WIDTH`/`DEFAULT_WINDOW_HEIGHT` constants; `DesktopShell.taskbar` is now public; `ShortcutRouter` ignores key-repeat events.
