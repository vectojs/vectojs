# @vectojs/table

## 0.1.1

### Patch Changes

- c97da27: fix(styles/desktop/table/markdown-app): clear the 2026-08 review backlog (#661)

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

- f893f30: Fix #606: virtualization no longer constructs every cell; roving focus survives wheel scroll.

  **Lazy cell materialization.** Virtualized tables built one `Text` per cell for
  _every_ row in the constructor and in each `appendRows` batch — O(rows×cols)
  cold text shaping up front and every entity kept alive even though only a
  window's worth ever mounts. Body-cell construction is now deferred to window
  materialization (`reconcileVirtualRows` builds a row the first time it enters
  the viewport); memory becomes proportional to visited rows, and mount time is
  independent of total row count. Classic mode still constructs eagerly.
  Duplicate-`Entity` rejection keeps its eager append-time timing via
  `reserveRowEntities`, so that contract is unchanged.

  **Roving focus re-anchors on window shift.** Wheel-scrolling the focused row out
  of the window detached its hotspot while the roving tab stop kept referencing
  it, dropping `document.activeElement` to the focus sentinel and killing all
  arrow-key navigation until a manual re-Tab. The table now detects the unmount of
  the tab-stop row during reconciliation, re-anchors the stop onto the nearest
  visible row before `tabIndex` binds, and restores DOM focus to it only when the
  old cell genuinely held focus (a table scrolled while focus lives elsewhere
  never steals it).

  **Scroll-overshoot crash.** The spring integrator could overshoot a freshly
  clamped scroll target (measured 2753 px against a 2286 px max) on a hard wheel
  fling; the a11y sync then derived an inverted visible range (`first > last`),
  drove the hotspot pool shrink loop negative, and crashed popping from an empty
  pool. Integrated `_scrollY` is now clamped every frame alongside `_targetY`.

  **Classic-mode a11y sync de-quadratified.** `_syncGridA11y` recomputed row-y
  prefix sums per pooled row on every `layout()`/`appendRows` — quadratic in rows.
  Row tops are now rebuilt in one fused pass inside `layout()` and read O(1) per
  slot.

  **ARIA grid keyboard parity.** PageUp/PageDown move the roving stop a viewport's
  worth of rows (exact under fixed virtualized row height; estimated from mean row
  height in classic mode), clamped at both ends.

  **DevTools metadata parity.** `GridCellHotspot` now overrides
  `getLayoutControlledProperties()` like its sibling `RowHotspot`.

## 0.1.0

### Minor Changes

- 5ce3422: Add the standalone `@vectojs/table` package for the canvas-native accessible Table component.
