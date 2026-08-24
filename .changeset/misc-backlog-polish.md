---
'@vectojs/desktop': patch
'@vectojs/styles': patch
'@vectojs/table': patch
'@vectojs/markdown-app': patch
---

fix(styles/desktop/table/markdown-app): clear the 2026-08 review backlog (#661)

**@vectojs/desktop**

- Remove unused public API: `DisplayLayout.setTaskbar` (DesktopShell reads the
  config directly; zero callers in src or tests) and `Vfs.baseName` (zero
  consumers anywhere).
- `Window.updateChrome` reads chrome values from the merged `this.chrome` after
  `Object.assign`, so a partial argument cannot clobber shell bg/border/radius
  and titlebar colors with undefined (latent today — both call sites pass full
  resolveChrome objects).
- `DesktopShell.setTheme` closes an open StartMenu first: the menu is not
  remounted by the swap and kept old colors plus a stale taskbar anchor.
- Taskbar `entriesHost` clips children, so overflowing entries stop painting
  over the clock area.

**@vectojs/styles**

- Font shorthand accepts a second/third `normal` (`font: normal normal 16px
Inter`): after the weight slot takes the first (documented compat choice),
  further `normal`s fill style then variant instead of falling into the size
  slot and throwing TypeError.
- Dropped internal `resolveStyle().hadVar`: computed but never read by any
  consumer including tests.

**@vectojs/table**

- Virtual row window upper bound is exact (`ceil(x) + overscan - 1`, matching
  `i*rh < scrollY + viewport + overscan*rh`); it previously mounted one extra
  fully-invisible row past the overscan budget per window.

**@vectojs/markdown-app**

- `MarkdownApp.setTheme` throws a TypeError listing valid presets on unknown
  theme names instead of silently no-oping, matching the fail-loud convention
  used across these packages.
