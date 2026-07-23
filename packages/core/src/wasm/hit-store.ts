/**
 * Gather world AABBs from a live scene subtree for the WASM hit-test grid.
 *
 * This mirrors `Scene.findHitRecursively`'s exact traversal (self, then EVERY
 * child in array order, recursively — `node.children` unconditionally, so
 * DOM-portal descendants and anything renderNode's rendering-specific
 * early-returns skip are still covered) so the grid-accelerated path can never
 * see a different entity set than the JS walk it replaces.
 *
 * Indices are assigned in PRE-ORDER (self before children, children in array
 * order): a node's own index is always lower than every index in its own
 * subtree, and an earlier sibling's whole subtree is entirely lower than a
 * later sibling's. Since `findHitRecursively` checks later siblings' subtrees
 * before earlier ones, and a node's children before the node itself, "highest
 * index wins" over this numbering is EXACTLY equivalent to that traversal's
 * topmost-hit priority — the invariant the WASM grid kernel's `idx > best`
 * comparison (see hit.rs) and the boundless-entity merge below both rely on.
 *
 * Entities without `getBounds()` (opted out of culling — "never known bounds")
 * cannot be spatially indexed at all; they are collected into `boundless`
 * instead, each tagged with its index, so the caller can still check them and
 * compare against the grid's best candidate by that same index.
 */
import type { AffineTransform, Entity } from '../tree/Entity';

export interface HitGatherResult {
  /** Total entities visited (bounded + boundless); the grid's `count`. */
  count: number;
  /** index -> Entity, for bounded entities (grid slot == array index). */
  slotEntity: Entity[];
  /** Entities with no `getBounds()`, each with its pre-order index, ascending. */
  boundless: Array<{ entity: Entity; index: number }>;
  /** World AABBs, indexed like `slotEntity` (a boundless index has garbage —
   *  never read, since those entities are only resolved via `boundless`). */
  minx: Float64Array;
  miny: Float64Array;
  maxx: Float64Array;
  maxy: Float64Array;
}

/** Walk `root` and all descendants into a flat, pre-order-indexed AABB set.
 *  `currentFrame` is the scene's frame counter — passed through to
 *  {@link Entity._readWorldCache} so the common case (every entity was
 *  rendered this same frame, which the "gather right after a render" call
 *  site always guarantees) reads six cached scalars per entity instead of
 *  allocating a fresh `{a,b,c,d,e,f}` object via `getWorldTransform()`. */
export function gatherHitAABBs(root: Entity, currentFrame: number): HitGatherResult {
  const slotEntity: Entity[] = [];
  const boundless: Array<{ entity: Entity; index: number }> = [];
  const minxs: number[] = [];
  const minys: number[] = [];
  const maxxs: number[] = [];
  const maxys: number[] = [];
  // Reused across every entity — _readWorldCache overwrites it in place, and
  // getWorldTransform()'s fallback result is copied out of it immediately, so
  // nothing ever reads a stale value left over from a previous entity.
  const scratch: AffineTransform = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };

  const visit = (node: Entity): void => {
    const index = slotEntity.length;
    slotEntity.push(node);
    const bounds = node.getBounds();
    if (bounds === null) {
      boundless.push({ entity: node, index });
      minxs.push(0);
      minys.push(0);
      maxxs.push(0);
      maxys.push(0);
    } else {
      if (!node._readWorldCache(currentFrame, scratch)) {
        // Rare fallback (entity not touched by this frame's render walk) —
        // still allocates, but only here, not on the common per-entity path.
        const t = node.getWorldTransform();
        scratch.a = t.a;
        scratch.b = t.b;
        scratch.c = t.c;
        scratch.d = t.d;
        scratch.e = t.e;
        scratch.f = t.f;
      }
      const { a, b, c, d, e, f } = scratch;
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (let i = 0; i < 4; i++) {
        const lx = i & 1 ? bounds.x + bounds.width : bounds.x;
        const ly = i & 2 ? bounds.y + bounds.height : bounds.y;
        const wx = a * lx + c * ly + e;
        const wy = b * lx + d * ly + f;
        if (wx < minX) minX = wx;
        if (wx > maxX) maxX = wx;
        if (wy < minY) minY = wy;
        if (wy > maxY) maxY = wy;
      }
      minxs.push(minX);
      minys.push(minY);
      maxxs.push(maxX);
      maxys.push(maxY);
    }
    const kids = node.children;
    for (let i = 0; i < kids.length; i++) visit(kids[i]);
  };
  visit(root);

  return {
    count: slotEntity.length,
    slotEntity,
    boundless,
    minx: Float64Array.from(minxs),
    miny: Float64Array.from(minys),
    maxx: Float64Array.from(maxxs),
    maxy: Float64Array.from(maxys),
  };
}
