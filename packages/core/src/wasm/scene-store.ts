/**
 * Build an SoA {@link TransformStore} from a live scene subtree.
 *
 * This is the bridge between the `Entity` tree and the WASM/JS transform core:
 * it reads each entity's local transform (`x/y/scaleX/scaleY/rotation/opacity`)
 * and emits the flat `InputNode[]` that {@link buildStore} turns into the
 * depth-ordered, contiguous-sibling-run layout the kernel requires. It returns a
 * map from `Entity` to its store index so a caller can read each entity's world
 * matrix back out of `store.worldView()`/`store.wa…` after composition.
 *
 * The passed `root` becomes store index 0 at the identity world transform — its
 * own local transform is ignored, matching how `Scene` seeds `renderNode` with
 * the identity for `root`/`overlayRoot`. It touches no render state; wiring it
 * into `Scene.render` is a separate, flagged step.
 */
import type { Entity } from '../tree/Entity';
import { buildStore, type InputNode, type TransformStore } from './soa';

export interface TreeStore {
  store: TransformStore;
  /** Entity -> its index in `store` (into `wa…`/`worldView`). */
  indexOf: Map<Entity, number>;
}

/**
 * Walk `root` and all descendants (via `entity.children`) into an SoA store.
 * Time O(n) in the subtree size; allocates one store per call (Stage 1 rebuilds
 * per frame — Stage 3 will cache on structural change).
 */
export function buildTreeStore(root: Entity): TreeStore {
  // Assign each entity an input-array index in pre-order; buildStore re-indexes
  // into depth-ordered sibling runs, so this order need not be depth-order.
  const entities: Entity[] = [];
  const inputIndex = new Map<Entity, number>();
  const collect = (e: Entity): void => {
    inputIndex.set(e, entities.length);
    entities.push(e);
    const kids = e.children;
    for (let i = 0; i < kids.length; i++) collect(kids[i]);
  };
  collect(root);

  const nodes: InputNode[] = entities.map((e) => {
    const parent = e.parent;
    const p = parent !== null && inputIndex.has(parent) ? inputIndex.get(parent)! : -1;
    return {
      parent: e === root ? -1 : p,
      x: e.x,
      y: e.y,
      scaleX: e.scaleX,
      scaleY: e.scaleY,
      rotation: e.rotation,
      opacity: e.opacity,
    };
  });

  const store = buildStore(nodes);

  const indexOf = new Map<Entity, number>();
  for (const [e, ii] of inputIndex) indexOf.set(e, store.storeIndexOf[ii]);
  return { store, indexOf };
}
