/**
 * Stateless helpers for the a11y projection's DOM mirrors.
 *
 * First module of the `Scene.ts` decomposition
 * (`forge/decisions/file-decomposition-2026-08.md` §2, `TODO.md`'s P3 refactor
 * entry). The decision record calls for extracting the stateless top-level
 * functions before any stateful manager, and these are both: pure functions of
 * their arguments, no `Scene` reference, no back-edge to `Scene.ts`. That keeps
 * the import graph a one-way edge (`Scene.ts → scene/a11y-dom.ts`) and avoids
 * the temporal-dead-zone hazard the Markdown split hit, where a module
 * importing a class back from its facade to `extends` it threw during module
 * initialization.
 *
 * Neither symbol is re-exported from `Scene.ts`. Both were module-private
 * there, and `packages/core/src/index.ts` is `export * from './tree/Scene'`, so
 * re-exporting would silently widen the public API — the opposite of this
 * refactor's byte-identical-surface requirement.
 *
 * When `A11yProjectionManager` (extraction 2) lands, it is the natural owner of
 * both. Until then `Scene` imports them directly.
 */

import type { AffineTransform } from '../Entity';

/**
 * Whether the element takes focus without an explicit `tabindex`.
 *
 * The projection adds `tabindex="0"` only to mirrors that need it: a mirror
 * carrying an interactive ARIA role but rendered as a non-focusable tag is
 * unreachable by keyboard, while adding `tabindex` to an element that is
 * already focusable is redundant and reorders nothing.
 */
export function isNativelyFocusable(element: HTMLElement): boolean {
  return (
    element instanceof HTMLButtonElement ||
    element instanceof HTMLInputElement ||
    element instanceof HTMLSelectElement ||
    element instanceof HTMLTextAreaElement ||
    (element instanceof HTMLAnchorElement && element.hasAttribute('href'))
  );
}

/**
 * A nested mirror's box, expressed relative to its projected parent.
 *
 * Reused across calls rather than returned fresh: the geometry write runs for
 * every projected node on every synced frame, and a virtualized table can
 * nest several hundred cells, so a per-node literal here would allocate in the
 * frame loop. The single caller consumes the fields immediately.
 */
export interface RebasedBox {
  left: number;
  top: number;
  matrix: string;
}

const REBASED_BOX: RebasedBox = { left: 0, top: 0, matrix: '' };

/**
 * Re-express a child's **world** transform as a box positioned inside its
 * projected parent's box.
 *
 * Mirrors are `position: absolute`, so their `left`/`top` resolve against the
 * nearest positioned ancestor. While the projection is flat that ancestor is
 * always `a11yRoot` and world coordinates are correct as-written. The moment a
 * mirror is nested inside another mirror, its containing block becomes the
 * parent — writing world coordinates then *double-offsets* every descendant,
 * and the parent's `matrix()` compounds on top. Measured in real Chrome and
 * Firefox: a row at world (110, 80) under a grid at (100, 50) landed at
 * (210, 130), and a cell at (120, 90) landed at (330, 220).
 *
 * The correction is not a plain subtraction. `left`/`top` are applied *before*
 * the ancestor's `transform`, so the offset has to be expressed in the parent's
 * pre-transform space: divide the world delta by the parent's linear part
 * rather than subtracting its translation. The linear part is likewise relative
 * — `inv(P) · C`, which collapses to the identity when the child adds no
 * rotation or scale of its own.
 *
 * Both engines reproduce the flat layout exactly under this transform,
 * including a parent rotated 30° and scaled 1.5×. That agreement depends on
 * `transformOrigin: '0 0'` (set on every mirror at creation); with the default
 * `50% 50%` each nested box rotates about its own centre and the results
 * diverge by tens of pixels.
 *
 * A singular parent matrix (zero width or height, or a collapsed scale) has no
 * inverse. Rather than emit `NaN` — which reads as `left: 0` and silently
 * relocates the element to the parent's origin, where the reading-order sort
 * would then treat it as the top-left-most element on screen — the child is
 * pinned to the parent's origin with an identity matrix. A zero-area parent is
 * already invisible, and `projectionBoxVisible` hides it on the same frame.
 */
export function rebaseChildBox(
  parent: AffineTransform,
  parentOriginX: number,
  parentOriginY: number,
  child: AffineTransform,
  childOriginX: number,
  childOriginY: number,
): RebasedBox {
  const det = parent.a * parent.d - parent.b * parent.c;
  if (!Number.isFinite(det) || Math.abs(det) < 1e-12) {
    REBASED_BOX.left = 0;
    REBASED_BOX.top = 0;
    REBASED_BOX.matrix = 'matrix(1, 0, 0, 1, 0, 0)';
    return REBASED_BOX;
  }

  // inv(P) linear part
  const ia = parent.d / det;
  const ib = -parent.b / det;
  const ic = -parent.c / det;
  const id = parent.a / det;

  // World translation delta, mapped back through inv(P) so it is expressed in
  // the space `left`/`top` actually apply in. Each box's `a11yOffset` is part
  // of its origin, so it belongs inside the delta rather than being added
  // afterwards: added afterwards, the child's own offset would be scaled by the
  // parent's transform and the parent's would not be subtracted at all.
  const dx = childOriginX - parentOriginX;
  const dy = childOriginY - parentOriginY;
  REBASED_BOX.left = ia * dx + ic * dy;
  REBASED_BOX.top = ib * dx + id * dy;

  // inv(P) · C, i.e. the child's transform relative to the parent's.
  const a = ia * child.a + ic * child.b;
  const b = ib * child.a + id * child.b;
  const c = ia * child.c + ic * child.d;
  const d = ib * child.c + id * child.d;
  REBASED_BOX.matrix = `matrix(${a}, ${b}, ${c}, ${d}, 0, 0)`;

  return REBASED_BOX;
}
