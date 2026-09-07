import type { AffineTransform } from '@vectojs/core';

/**
 * Embed a 2D world affine matrix as a CSS `matrix3d()` string (RFC §5 rule 1).
 *
 * The affine `[a c e; b d f; 0 0 1]` becomes the 4x4 column-major
 * `matrix3d(a, b, 0, 0, c, d, 0, 0, 0, 0, 1, 0, e, f, 0, 1)`. One code path for
 * 2D and camera-composed 3D scenes (uniformity preferred over the portal
 * path's `matrix(...)`; per-frame string cost at realistic DOM-node counts is
 * unmeasured — RFC §11 risk 4 — so this stays behind the same per-field
 * dirty check the portals use, and steady-state frames write nothing).
 *
 * Correctness note: the browser renders the element (selection highlight,
 * caret, focus ring, children) _first_ and transforms the rendered result
 * after, which is why selection keeps its perspective shape under rotation.
 */
export function affineToMatrix3d(m: AffineTransform): string {
  return `matrix3d(${m.a}, ${m.b}, 0, 0, ${m.c}, ${m.d}, 0, 0, 0, 0, 1, 0, ${m.e}, ${m.f}, 0, 1)`;
}
