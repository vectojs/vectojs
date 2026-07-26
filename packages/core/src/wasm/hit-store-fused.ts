/**
 * Build the hit-test grid's AABB set from the resident WASM transform store,
 * instead of recomputing every world AABB in JavaScript.
 *
 * Why this exists: the WASM hit grid's *kernel* is 65-170x faster than the JS
 * depth-first walk, but the integrated path was measured **slower** for an
 * ordinary hover — 11.2ms versus 39us at 100k entities. All of that went to the
 * JS gather in front of it: walk the tree, `getWorldTransform()`, `getBounds()`,
 * transform four corners per entity, push into arrays, copy into WASM views. The
 * kernel win was real and the gather ate it.
 *
 * When the transform backend is active, those world AABBs already exist inside
 * WASM memory: `compose_*` filled the world matrices and `compute_aabbs` reduced
 * them to `aminx/aminy/amaxx/amaxy`. So the gather can become a copy between two
 * views of the *same* linear memory (possible only because all backends now share
 * one instance) plus the index remap below.
 *
 * The remap is the whole subtlety. Two different index spaces are in play:
 *
 * - The **transform store** re-indexes entities into depth-ordered, contiguous
 *   sibling runs, because that is what the SIMD composer needs.
 * - The **hit grid** requires strict **pre-order** indices, because its
 *   `idx > best` tie-break is only equivalent to `findHitRecursively`'s
 *   topmost-hit priority under that numbering.
 *
 * Those orders differ, so this walks the tree in pre-order exactly as
 * {@link gatherHitAABBs} does — preserving the priority invariant — and for each
 * entity reads its AABB from `entity._storeSlot`. Nothing about which entity wins
 * a hit changes; only where the four numbers come from.
 */
import type { Entity } from '../tree/Entity';
import type { HitGatherResult } from './hit-store';

/** The resident world-AABB views of the transform backend. */
export interface ResidentAabbs {
  aminx: Float64Array;
  aminy: Float64Array;
  amaxx: Float64Array;
  amaxy: Float64Array;
}

/**
 * Pre-order walk collecting AABBs out of the transform store.
 *
 * Returns `null` when the store cannot answer for some entity — an unassigned or
 * out-of-range `_storeSlot`, which happens legitimately when the tree changed
 * after the last store rebuild. The caller then falls back to the JS gather
 * rather than indexing a stale slot, because a wrong AABB would mean a wrong
 * entity under the cursor, and a slower correct answer beats a fast wrong one.
 *
 * `slotEntity` here is the *hit* grid's pre-order mapping, unrelated to the
 * transform store's slots despite the shared name in the result type.
 */
export function gatherHitAABBsFromStore(
  root: Entity,
  aabbs: ResidentAabbs,
  storeSlotEntity: readonly Entity[],
  out: HitGatherResult,
): HitGatherResult | null {
  const slotEntity = out.slotEntity;
  const boundless = out.boundless;
  slotEntity.length = 0;
  boundless.length = 0;

  let count = 0;
  let capacity = out.minx.length;
  let minx = out.minx;
  let miny = out.miny;
  let maxx = out.maxx;
  let maxy = out.maxy;

  const grow = (needed: number): void => {
    if (needed <= capacity) return;
    let next = capacity || 256;
    while (next < needed) next *= 2;
    const nminx = new Float64Array(next);
    const nminy = new Float64Array(next);
    const nmaxx = new Float64Array(next);
    const nmaxy = new Float64Array(next);
    nminx.set(minx);
    nminy.set(miny);
    nmaxx.set(maxx);
    nmaxy.set(maxy);
    minx = nminx;
    miny = nminy;
    maxx = nmaxx;
    maxy = nmaxy;
    capacity = next;
  };

  let bailed = false;

  const visit = (node: Entity): void => {
    if (bailed) return;
    const index = count;
    slotEntity.push(node);
    count++;
    grow(count);

    // A boundless entity (no getBounds()) cannot be spatially indexed at all;
    // it is resolved through `boundless` and never reads these four slots.
    if (node.getBounds() === null) {
      boundless.push({ entity: node, index });
      minx[index] = 0;
      miny[index] = 0;
      maxx[index] = 0;
      maxy[index] = 0;
    } else {
      const slot = node._storeSlot;
      // `storeSlotEntity[slot] === node` is the identity check that makes this
      // safe: a slot index alone can be stale after a tree change and would
      // silently address another entity's AABB.
      if (slot < 0 || slot >= aabbs.aminx.length || storeSlotEntity[slot] !== node) {
        bailed = true;
        return;
      }
      minx[index] = aabbs.aminx[slot]!;
      miny[index] = aabbs.aminy[slot]!;
      maxx[index] = aabbs.amaxx[slot]!;
      maxy[index] = aabbs.amaxy[slot]!;
    }

    // Mirror findHitRecursively / gatherHitAABBs exactly: every child, in array
    // order, unconditionally. Diverging here would let the grid see a different
    // entity set than the JS walk it replaces.
    const children = node.children;
    for (let i = 0; i < children.length; i++) visit(children[i]!);
  };

  visit(root);
  if (bailed) return null;

  out.count = count;
  out.minx = minx;
  out.miny = miny;
  out.maxx = maxx;
  out.maxy = maxy;
  return out;
}

/** A reusable result buffer, so the fused path allocates nothing per query. */
export function createHitGatherBuffer(): HitGatherResult {
  return {
    count: 0,
    slotEntity: [],
    boundless: [],
    minx: new Float64Array(256),
    miny: new Float64Array(256),
    maxx: new Float64Array(256),
    maxy: new Float64Array(256),
  };
}
