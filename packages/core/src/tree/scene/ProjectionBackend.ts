import type { AffineTransform, Entity } from '../Entity';

/**
 * Stable backend id for telemetry and capability negotiation (cf. RFC4).
 *
 * The three literals name the projections that exist today; the open-ended
 * tail leaves room for RFC2+ backends without touching this type. `'content'`
 * extends the RFC1 sketch's `canvas | dom | a11y` union: the sketch's table
 * already lists `ContentProjection` as a first-class row, so the kind union
 * names it too.
 */
export type ProjectionBackendKind = 'canvas' | 'dom' | 'a11y' | 'content' | (string & {});

/**
 * A materialization of scene nodes in one medium: canvas pixels, an
 * `HTMLElement` subtree, an accessibility node, or a future backend's own
 * representation.
 *
 * This is vocabulary, not machinery (RFC1 §5, CTX-0597): it names the
 * mount/update/unmount shape the existing projections already follow so
 * RFC2 (DOM projection), RFC3 (semantic/a11y projection), and RFC4
 * (projection policy) can each name which row they implement or consume.
 * `@vectojs/dom` implements the `'dom'` row (`DOMProjection`); the rows below
 * map each backend onto the code that performs its role, with the invariant
 * from RFC1 §2: two projections of the same node must agree on geometry
 * (world matrix), visibility, and lifecycle state, while each keeps its own
 * medium-specific representation.
 *
 * | Backend (proposed name) | Exists today as | Mount site |
 * | ----------------------- | --------------- | ---------- |
 * | `CanvasProjection` (`'canvas'`) | the main render pass via `IRenderer` | `Scene.render(renderer)` (`tree/Scene.ts`) → per-entity `Entity.render` (`tree/Entity.ts`) |
 * | `A11yProjection` (`'a11y'`) | `A11yProjectionManager` + `a11yRoot` mirrors | mirror creation in the `Scene.syncA11y` walk (`tree/Scene.ts`); ordering in `A11yProjectionManager` |
 * | `ContentProjection` (`'content'`) | `ContentProjectionManager` + `Entity.getContentProjection` | `Scene.syncContentProjection`, driven on the a11y sync cadence (`tree/Scene.ts`) |
 * | `DOMProjection` (`'dom'`) | `@vectojs/dom` (`DOMProjection`, driven from the render walk) | `Scene.addProjectionBackend` + walk hook (`tree/Scene.ts`) |
 *
 * Open points deliberately left to RFC2/RFC4 (RFC1 §5): whether `update`
 * receives the full matrix or a decomposed transform, how z-order/layering
 * composes canvas pixels under/over DOM elements, and event forwarding
 * ownership (constrained by `forge/input-dispatch-contract-v2-design.md` §4).
 */
export interface ProjectionBackend {
  /** Stable backend id for telemetry and capability negotiation (cf. RFC4). */
  readonly kind: ProjectionBackendKind;
  /** Create backend state for a newly materialized node. Idempotent. */
  mount(node: Entity): void;
  /**
   * Reconcile backend state after a layout/transform/visibility change.
   *
   * Takes the node's {@link Entity.getWorldTransform | world transform} as
   * {@link AffineTransform} rather than the sketch's `Float64Array`: that is
   * what the scene computes today, and it converts losslessly to the
   * `matrix3d()` a DOM backend wants. The matrix-vs-decomposed question stays
   * open for RFC2/RFC4 per RFC1 §5.
   */
  update(node: Entity, worldMatrix: AffineTransform): void;
  /** Tear down backend state on removal or policy change. Idempotent. */
  unmount(node: Entity): void;
  /**
   * Whether `node` currently owns an active gesture on this backend (RFC4 §5,
   * CTX-0601). Consulted by the scene's capability negotiation alongside its
   * own mirror pins: a pinned node keeps its backend until gesture end —
   * input-dispatch-contract-v2 §4 gesture stickiness, no mid-gesture handoff.
   * Optional so test fakes stay three methods; absent means "no gestures".
   */
  hasActiveGesture?(node: Entity): boolean;
}
