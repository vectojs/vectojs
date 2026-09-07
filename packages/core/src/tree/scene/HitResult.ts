import type { Entity, Point } from '../Entity';

/**
 * Which medium painted the hit node (RFC5 §2, CTX-0600).
 *
 * - `'canvas'` — the canvas spatial test (`Scene.findEntityAt`).
 * - `'mirror'` — an `a11yRoot` mirror element under the cursor.
 * - `'portal'` — a `portalRoot` element (`DOMPortalEntity` bridge precedent,
 *   `tree/DOMPortalEntity.ts:64-99`).
 * - `'dom-visual'` — extension point for CTX-0598's DOM backend: accepted and
 *   attributed through the same predicate path today, without depending on
 *   that package existing yet.
 */
export type HitBackend = 'canvas' | 'dom-visual' | 'mirror' | 'portal';

/**
 * One candidate in the merged hit list (RFC5 §2).
 *
 * Coordinates enter in scene space and attribution follows (RFC5 §2 rule 3):
 * `worldPoint` is the queried scene-space point, `localPoint` is that point
 * in the node's local space (`Entity.worldToLocal`, `null` when the
 * accumulated transform is singular).
 *
 * `priority` is compositor-layer order, then paint order (RFC5 §2 rule 2 and
 * §3): the overlay subtree sorts above the main tree, and within one subtree
 * DOM-native backends sort above canvas. Computed as
 * `(inOverlaySubtree ? 2 : 0) + (backend === 'canvas' ? 0 : 1)`, so
 * overlay-DOM (3) > overlay-canvas (2) > main-DOM (1) > main-canvas (0).
 * Sort descending; ties keep insertion order (stable sort).
 */
export interface HitResult {
  node: Entity;
  backend: HitBackend;
  localPoint: Point | null;
  worldPoint: Point;
  priority: number;
}

/**
 * A caller-observed DOM-native hit offered to the merge
 * (`HitTester.findHitsAt`). The browser's own hit test over the
 * `pointer-events: auto` element is the geometric authority, so the merge
 * gates the owning node with the same visibility/input predicate as the
 * canvas paths (`disabled` / `pointerEvents: 'none'` exclusion, opacity,
 * `clipChildren`) but does not re-check scene-space `isPointInside`.
 *
 * `'canvas'` is excluded: canvas candidates come from the spatial test, never
 * from the caller.
 */
export interface DomHitCandidate {
  node: Entity;
  backend: Exclude<HitBackend, 'canvas'>;
}
