/**
 * Pointer hit-testing: which entity is under a point, by two paths that must
 * agree.
 *
 * Extraction 4 of the `Scene.ts` decomposition
 * (`forge/decisions/file-decomposition-2026-08.md` §2). `Scene.findEntityAt`
 * keeps its name and signature and delegates here.
 *
 * ## The two paths, and why both exist
 *
 * The **JS depth-first walk** ({@link findHitRecursively}) is the permanent
 * fallback and the definition of correct: children in reverse draw order,
 * topmost hit wins, clipped by every `clipChildren` ancestor.
 *
 * The **WASM broad phase** ({@link findEntityAt}'s accelerated arm) asks a
 * spatial grid for one cell's candidates. It is flat, so it has no recursion
 * clip-stack, which is why {@link isHitEligible} re-applies the same
 * visibility/clip/pointer gating the walk gets structurally. Keeping those two
 * in lockstep is the whole correctness argument for having a second path — if
 * they can disagree, the accelerator is a bug generator rather than an
 * optimisation.
 *
 * ## What this owns
 *
 * The hit-grid *contents* — the slot→entity table, the boundless list, and the
 * reused fused-gather buffer. The cache *key* (`hitGridFrame`, `hitGridOk`) stays
 * on {@link WasmBackendFacade}, because installing a backend has to invalidate
 * it and that is the facade's business.
 *
 * ## What it deliberately does not own
 *
 * `clientToScene` and `setupEvents` sit under hit-test banners but are not hit
 * testing:
 *
 * - `clientToScene` maps browser viewport coordinates to logical ones from
 *   `canvas`, `width` and `height` — all `ContextAndResize` state (extraction 5).
 * - `setupEvents` wires the window resize listener, the embedded-canvas
 *   `ResizeObserver`, the DPR watch, and the pointer listeners that write
 *   `mouseX`/`mouseY`. Almost all of it is resize and canvas lifecycle.
 *
 * That is a fifth instance of `DEC-0016`'s finding that the domain banners
 * expose wrong cuts — the same shape as `syncOverlayGeometry` in extraction 2.
 *
 * ## What is passed in, and why
 *
 * `root` and `overlayRoot` are held: `Scene` assigns both once in its constructor
 * and never reassigns them. The facade is held because the hit backend is reached
 * only through its public surface (`hit`, `hitReason`, `hitGridFrame`,
 * `hitGridOk`, `ensureAabbs()`, `slotEntity`, `hitFusedGather`, `transform`).
 *
 * The frame counter and the viewport size are **per-call arguments** (`DEC-0019`
 * rule 5): `currentFrame` belongs to the render scheduler (extraction 6) and
 * `width`/`height` are mutated by `resize` (extraction 5), so neither can be
 * captured at construction without going stale.
 */

import type { Bounds, Entity } from '../Entity';
import { gatherHitAABBs } from '../../wasm/hit-store';
import { createHitGatherBuffer, gatherHitAABBsFromStore } from '../../wasm/hit-store-fused';
import type { WasmBackendFacade } from './WasmBackendFacade';

/** Axis-aligned intersection of two world-space boxes (empty if disjoint). */
function intersectBounds(a: Bounds, b: Bounds): Bounds {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  return {
    x,
    y,
    width: Math.max(0, right - x),
    height: Math.max(0, bottom - y),
  };
}

export class HitTester {
  private readonly root: Entity;
  private readonly overlayRoot: Entity;
  private readonly backends: WasmBackendFacade;

  /** Slot index → entity, as built by the most recent grid build. */
  private slotEntity: Entity[] = [];
  /** Entities with no `getBounds()`, which the grid cannot index. */
  private boundless: Array<{ entity: Entity; index: number }> = [];
  /** Reused buffer for the fused gather, so a pointer query allocates nothing. */
  private gatherBuffer: ReturnType<typeof createHitGatherBuffer> | null = null;

  public constructor(root: Entity, overlayRoot: Entity, backends: WasmBackendFacade) {
    this.root = root;
    this.overlayRoot = overlayRoot;
    this.backends = backends;
  }

  /**
   * Finds the topmost interactive entity at the given coordinates.
   *
   * @param frame - `Scene.currentFrame`, the grid cache key's frame stamp.
   * @param width - Scene logical width, for the grid's extent.
   * @param height - Scene logical height, for the grid's extent.
   */
  public findEntityAt(
    x: number,
    y: number,
    frame: number,
    width: number,
    height: number,
  ): Entity | null {
    // 1. Search overlay root first (drawn on top). Overlays are never indexed
    // by the WASM grid (modals/menus are few and rare — not worth
    // accelerating), so this always uses the JS walk.
    const overlayHit = this.findHitRecursively(this.overlayRoot, x, y);
    if (overlayHit) return overlayHit;

    // 2. Search main scene tree. The WASM path is conclusive whenever the
    // grid is trustworthy (backend present, build didn't overflow) — it
    // returns the correct entity or null, never "inconclusive" — so no
    // further JS fallback is needed for that call. Otherwise (no backend, or
    // an overflowing build) fall back to the permanent JS walk.
    if (this.backends.hit && this.ensureHitGrid(frame, width, height)) {
      return this.findEntityAtWasm(x, y);
    }
    return this.findHitRecursively(this.root, x, y);
  }

  /**
   * Refresh the hit-test grid for the CURRENT tree state if it is stale (a
   * structural or transform change may have happened since the last build —
   * there is no cheap "nothing moved" shortcut for a spatial index the way
   * there is for the transform store's topology-only run table, since ANY
   * entity moving invalidates its AABB, not just add/remove/reparent; the
   * measured build cost is cheap enough to redo per call). Returns `false`
   * (grid untrustworthy — caller must use the JS walk) when there is no
   * backend or the build overflowed its item budget.
   */
  public ensureHitGrid(frame: number, width: number, height: number): boolean {
    const backend = this.backends.hit;
    if (!backend) {
      this.backends.hitReason = 'not-installed';
      return false;
    }
    if (this.backends.hitGridFrame === frame) {
      return this.backends.hitGridOk;
    }

    // Prefer the fused path: when the transform backend is active it has already
    // reduced every world matrix to an AABB inside the SAME linear memory (all
    // backends share one instance), so the gather becomes a copy plus an index
    // remap instead of re-deriving four transformed corners per entity in JS.
    //
    // That JS gather is what made the integrated hit-test path *slower* than the
    // JS walk for an ordinary hover despite a 65-170x faster kernel: 11.2ms vs
    // 39us at 100k entities, essentially all of it in front of the kernel.
    //
    // It returns null when the store cannot answer (a tree change since the last
    // rebuild leaves a stale `_storeSlot`), in which case fall through to the JS
    // gather — a wrong AABB would mean the wrong entity under the cursor, and a
    // slower correct answer beats a faster wrong one.
    let gathered: ReturnType<typeof gatherHitAABBs> | null = null;
    const transform = this.backends.transform;
    if (transform && this.backends.ensureAabbs()) {
      this.gatherBuffer ??= createHitGatherBuffer();
      transform.revalidateViews();
      gathered = gatherHitAABBsFromStore(
        this.root,
        transform.aabbView(),
        this.backends.slotEntity,
        this.gatherBuffer,
      );
      if (gathered) this.backends.hitFusedGather = true;
    }
    if (!gathered) {
      this.backends.hitFusedGather = false;
      gathered = gatherHitAABBs(this.root, frame);
    }
    // ensure() must run BEFORE writing AABBs: a capacity growth detaches the
    // previous typed-array views, so sizing after writing would write into a
    // stale buffer.
    backend.ensure(gathered.count, width, height, 64);
    backend.revalidateViews();
    const view = backend.inputView();
    view.minx.set(gathered.minx.subarray(0, gathered.count));
    view.miny.set(gathered.miny.subarray(0, gathered.count));
    view.maxx.set(gathered.maxx.subarray(0, gathered.count));
    view.maxy.set(gathered.maxy.subarray(0, gathered.count));
    const ok = backend.runBuild(gathered.count, width, height, 64);

    this.slotEntity = gathered.slotEntity;
    this.boundless = gathered.boundless;
    this.backends.hitGridFrame = frame;
    this.backends.hitGridOk = ok;
    // `runBuild` returns false when the build overflowed its item budget, which
    // makes the grid untrustworthy — a real decline, not merely "not asked".
    this.backends.hitReason = ok ? 'active' : 'rejected';
    return ok;
  }

  /**
   * `findEntityAt`'s WASM-accelerated path for the main tree. Scans only the
   * queried cell's candidates (confirming each against its own AABB and precise
   * `isPointInside`) merged against the (typically empty or tiny) list of
   * entities with no `getBounds()`, taking whichever confirmed match has the
   * higher pre-order index — see hit-store.ts for why that is exactly
   * equivalent to findHitRecursively's topmost-hit priority. Always
   * conclusive: returns the correct entity or `null`, never "inconclusive".
   */
  private findEntityAtWasm(x: number, y: number): Entity | null {
    const backend = this.backends.hit!;
    const { minx, miny, maxx, maxy } = backend.inputView();
    let bestIndex = -1;
    let bestEntity: Entity | null = null;

    const cell = backend.candidatesAt(x, y);
    if (cell) {
      // Ascending index order; scan from the end for topmost (highest index)
      // first, so the first candidate that passes both checks is already the
      // topmost possible confirmed hit among the grid's candidates.
      for (let k = cell.length - 1; k >= 0; k--) {
        const idx = cell[k];
        if (x < minx[idx] || x > maxx[idx] || y < miny[idx] || y > maxy[idx]) continue;
        const entity = this.slotEntity[idx];
        if (entity?.isPointInside(x, y) && this.isHitEligible(entity, x, y)) {
          bestIndex = idx;
          bestEntity = entity;
          break;
        }
      }
    }
    for (const { entity, index } of this.boundless) {
      if (index > bestIndex && entity.isPointInside(x, y) && this.isHitEligible(entity, x, y)) {
        bestIndex = index;
        bestEntity = entity;
      }
    }
    return bestEntity;
  }

  public findHitRecursively(
    node: Entity,
    x: number,
    y: number,
    clip: Bounds | null = null,
  ): Entity | null {
    // An invisible subtree (opacity 0) is not drawn, so nothing in it should be
    // hit — skip the node AND its children (opacity accumulates down the tree).
    if (node.opacity <= 0) return null;

    // A `clipChildren` node clips its descendants to its world box: intersect it
    // into the clip rect passed down to the children (but the node itself is
    // still hit-testable against the incoming clip).
    let childClip = clip;
    if (node.clipChildren) {
      const box = node.getWorldBounds();
      childClip = clip ? intersectBounds(clip, box) : box;
    }

    // Walk children in reverse order (drawn last/top-most first).
    for (let i = node.children.length - 1; i >= 0; i--) {
      const hit = this.findHitRecursively(node.children[i], x, y, childClip);
      if (hit) return hit;
    }

    // The node itself is a hit target only if the point is inside it, inside
    // every clipping ancestor's EXACT local rect, and it isn't opted out of
    // pointer input (a disabled control or an explicit `pointerEvents: 'none'`).
    if (
      node.isPointInside &&
      node.isPointInside(x, y) &&
      this.isInsideAllClippers(node, x, y) &&
      !this.isPointerTransparent(node)
    ) {
      return node;
    }

    return null;
  }

  /** Whether `node` opts out of being a pointer hit target: a disabled control
   *  or an explicit `pointerEvents: 'none'` in its a11y attributes. Its children
   *  are still walked (a transparent container can hold hittable descendants). */
  private isPointerTransparent(node: Entity): boolean {
    const attrs = node.getA11yAttributes();
    return attrs.disabled === true || attrs.pointerEvents === 'none';
  }

  /**
   * Exact rotation-aware `clipChildren` test shared by BOTH hit paths: the
   * point must lie inside every clipChildren ancestor's local rect — the same
   * shape rendering clips to — not merely inside the ancestor's world AABB.
   * For a rotated clipper those disagree, and until both paths used the exact
   * rect a query's answer depended on which backend was active (#680). The
   * clip-stack AABB intersection in {@link findHitRecursively} remains purely
   * as a subtree-pruning pre-filter; this is the authoritative gate.
   */
  private isInsideAllClippers(node: Entity, x: number, y: number): boolean {
    for (let ancestor = node.parent; ancestor; ancestor = ancestor.parent) {
      if (!ancestor.clipChildren) continue;
      const local = ancestor.worldToLocal(x, y);
      if (
        !local ||
        local.x < 0 ||
        local.y < 0 ||
        local.x > ancestor.width ||
        local.y > ancestor.height
      ) {
        return false;
      }
    }
    return true;
  }

  /**
   * Whether a confirmed geometric hit on `node` at world `(x, y)` is a REAL hit,
   * applying the same visibility/input gating as {@link findHitRecursively} but
   * from a flat candidate (the WASM grid has no recursion clip-stack): the node
   * and all ancestors are visible (`opacity > 0`), the point lies inside every
   * `clipChildren` ancestor's world box, and the node isn't pointer-transparent
   * (disabled / `pointerEvents: 'none'`). Keeps the WASM and JS hit paths in
   * lockstep so they return the same entity.
   */
  private isHitEligible(node: Entity, x: number, y: number): boolean {
    if (this.isPointerTransparent(node)) return false;
    if (node.opacity <= 0) return false;
    for (let ancestor = node.parent; ancestor; ancestor = ancestor.parent) {
      if (ancestor.opacity <= 0) return false;
    }
    return this.isInsideAllClippers(node, x, y);
  }
}
