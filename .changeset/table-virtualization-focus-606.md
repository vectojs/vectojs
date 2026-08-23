---
'@vectojs/table': patch
---

Fix #606: virtualization no longer constructs every cell; roving focus survives wheel scroll.

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
