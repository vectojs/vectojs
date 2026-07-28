import type { Bounds, Entity, Scene } from '@vectojs/core';
import { textPreviewOf } from './inspect';

/**
 * One node of a captured scene state. Boolean flags and default-valued
 * properties are omitted rather than written as `false`/`1` so that
 * JSON.stringify output (and diffs of it) stay quiet.
 */
export interface SnapshotNode {
  type: string;
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  worldBounds: Bounds;
  opacity?: number;
  interactive?: true;
  animating?: true;
  clipChildren?: true;
  text?: string;
  /**
   * Position-independent identity used to pair nodes across two captures.
   *
   * Omitted when nothing better than the child index is available, which is
   * what {@link nodeKey} decides. Recorded on the node so a snapshot stays
   * self-describing: a diff of two stored captures must not need the live scene
   * to work out how they were paired.
   */
  key?: string;
  children?: SnapshotNode[];
}

export interface SceneSnapshot {
  width: number;
  height: number;
  root: SnapshotNode[];
  overlay: SnapshotNode[];
}

export interface SnapshotDiff {
  /**
   * Path to the node, e.g. `root > Card[0] > Text[2]` for an index-matched node
   * or `root > Row{k:row-42}` for a keyed one. Never contains an entity id:
   * those are random per run, paths are not.
   */
  path: string;
  kind: 'added' | 'removed' | 'changed';
  changes?: Record<string, { from: unknown; to: unknown }>;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

/** Longest label accepted as a key, so one huge string cannot dominate a diff. */
const KEY_LABEL_MAX = 64;

/**
 * Position-independent identity for a node, or `undefined` to fall back to the
 * child index.
 *
 * Preference order, most to least trustworthy:
 *
 * 1. `devtoolsKey` — declared by the component precisely for this purpose, so a
 *    row id or message id survives reordering and recycling.
 * 2. The accessible label — what identifies a control to a user, and stable
 *    while the control's contents change.
 *
 * Drawn text is deliberately NOT a candidate. A key is identity, and text is
 * content: keying on it would turn every edit of a text node into a removal plus
 * an addition instead of one `changed` entry, losing the from/to that makes a
 * text diff useful. An unlabelled text node therefore matches by index, which is
 * correct — it has no identity of its own.
 *
 * A key only helps if it is unique among its siblings; {@link keyedPairs}
 * discards a whole level's keys when they collide rather than pairing wrongly.
 * The entity id is never a candidate: ids are regenerated every run, so keying
 * on them would make every cross-run diff total.
 */
function nodeKey(entity: Entity): string | undefined {
  // Each source is app-supplied and may throw; a broken getter must degrade to
  // index matching rather than fail the capture.
  try {
    const declared = entity.getDevtoolsDescriptor?.()?.devtoolsKey;
    if (typeof declared === 'string' && declared.length > 0) return `k:${declared}`;
  } catch {
    /* fall through to the next source */
  }
  try {
    const label = entity.getA11yAttributes?.()?.label;
    if (typeof label === 'string' && label.length > 0) {
      return `l:${label.slice(0, KEY_LABEL_MAX)}`;
    }
  } catch {
    /* fall through to the next source */
  }
  return undefined;
}

function toNode(entity: Entity): SnapshotNode {
  const wb = entity.getWorldBounds();
  const node: SnapshotNode = {
    type: entity.constructor.name,
    id: entity.id,
    x: round2(entity.x),
    y: round2(entity.y),
    width: round2(entity.width),
    height: round2(entity.height),
    worldBounds: {
      x: round2(wb.x),
      y: round2(wb.y),
      width: round2(wb.width),
      height: round2(wb.height),
    },
  };
  if (entity.opacity !== 1) node.opacity = round2(entity.opacity);
  if (entity.interactive) node.interactive = true;
  if (entity.hasPendingAnimations()) node.animating = true;
  if (entity.clipChildren) node.clipChildren = true;
  const text = textPreviewOf(entity);
  if (text !== undefined) node.text = text;
  const key = nodeKey(entity);
  if (key !== undefined) node.key = key;
  if (entity.children.length > 0) node.children = entity.children.map(toNode);
  return node;
}

/**
 * Capture the full scene state as a deterministic, JSON-safe tree: child
 * order is render order, all numbers rounded to 2 decimals, defaults omitted.
 * Two captures of an unchanged scene are deep-equal (ids aside, which are
 * stable within a run) — pair with {@link diffSnapshots} for state assertions.
 */
export function captureSnapshot(scene: Scene): SceneSnapshot {
  return {
    width: round2(scene.width),
    height: round2(scene.height),
    root: scene.rootEntity.children.map(toNode),
    overlay: scene.overlayRootEntity.children.map(toNode),
  };
}

const COMPARED_KEYS = [
  'type',
  'x',
  'y',
  'width',
  'height',
  'worldBounds',
  'opacity',
  'interactive',
  'animating',
  'clipChildren',
  'text',
] as const;

/**
 * Path segment for a node.
 *
 * A keyed node is addressed by its key so the path itself survives reordering —
 * `root > Row{k:row-42}` stays the same after an insertion above it, whereas
 * `root > Row[7]` becomes `[8]` and reads as a change to a different row.
 */
function pathOf(parent: string, node: SnapshotNode, index: number, keyed: boolean): string {
  // Only address by key when the pair was actually matched by key. Printing a
  // key that pairing ignored would name a node ambiguously — two siblings both
  // labelled "Delete" would produce the same path.
  const segment =
    keyed && node.key !== undefined ? `${node.type}{${node.key}}` : `${node.type}[${index}]`;
  return `${parent} > ${segment}`;
}

/** A pairing of nodes between two captures; a missing side means added/removed. */
interface Pairing {
  a?: SnapshotNode;
  b?: SnapshotNode;
  /** Index used for the path when the pair was not matched by key. */
  index: number;
  /** Whether this pair was matched by key, which decides how it is addressed. */
  keyed: boolean;
}

/**
 * Pair siblings by key where possible, falling back to index alignment.
 *
 * Index alignment does not merely inflate a head insertion, it MISATTRIBUTES it.
 * Measured on a 200-row list with distinct row text, inserting at the head
 * produces 201 diffs either way — the rows really did move — but unkeyed, all
 * 200 also claim their text was rewritten, because each row is compared against
 * its neighbour, and the new row is reported at index 200, the tail, since that
 * is the only index left without a partner.
 *
 * Keys are used only when they are unique on BOTH sides of this level. Duplicate
 * keys (two rows both labelled "Delete") would otherwise pair arbitrarily and
 * report changes that never happened, which is worse than an honest index diff.
 */
function keyedPairs(a: SnapshotNode[], b: SnapshotNode[]): Pairing[] {
  const usable = hasUniqueKeys(a) && hasUniqueKeys(b);
  if (!usable) {
    const max = Math.max(a.length, b.length);
    const pairs: Pairing[] = [];
    for (let i = 0; i < max; i++) pairs.push({ a: a[i], b: b[i], index: i, keyed: false });
    return pairs;
  }

  const byKeyA = new Map<string, SnapshotNode>();
  for (const node of a) if (node.key !== undefined) byKeyA.set(node.key, node);

  const pairs: Pairing[] = [];
  const claimed = new Set<string>();
  // Walk `b` so the output is ordered by the new tree, which is the order a
  // reader is looking at.
  b.forEach((nb, index) => {
    if (nb.key === undefined) {
      pairs.push({ a: a[index], b: nb, index, keyed: false });
      return;
    }
    const na = byKeyA.get(nb.key);
    if (na) claimed.add(nb.key);
    pairs.push({ a: na, b: nb, index, keyed: true });
  });
  // Anything in `a` never claimed was removed.
  a.forEach((na, index) => {
    if (na.key === undefined) {
      // An unkeyed node beyond `b`'s length is a removal; within it, it was
      // already paired positionally above.
      if (index >= b.length) pairs.push({ a: na, index, keyed: false });
      return;
    }
    if (!claimed.has(na.key)) pairs.push({ a: na, index, keyed: true });
  });
  return pairs;
}

/** True when every keyed node in the list carries a distinct key. */
function hasUniqueKeys(nodes: SnapshotNode[]): boolean {
  const seen = new Set<string>();
  for (const node of nodes) {
    if (node.key === undefined) continue;
    if (seen.has(node.key)) return false;
    seen.add(node.key);
  }
  return true;
}

function diffNodes(
  a: SnapshotNode[],
  b: SnapshotNode[],
  parent: string,
  out: SnapshotDiff[],
): void {
  for (const { a: na, b: nb, index, keyed } of keyedPairs(a, b)) {
    if (na && !nb) {
      out.push({ path: pathOf(parent, na, index, keyed), kind: 'removed' });
      continue;
    }
    if (!na && nb) {
      out.push({ path: pathOf(parent, nb, index, keyed), kind: 'added' });
      continue;
    }
    if (!na || !nb) continue;
    const path = pathOf(parent, nb, index, keyed);
    const changes: Record<string, { from: unknown; to: unknown }> = {};
    for (const key of COMPARED_KEYS) {
      const va = na[key];
      const vb = nb[key];
      const same = key === 'worldBounds' ? JSON.stringify(va) === JSON.stringify(vb) : va === vb;
      if (!same) changes[key] = { from: va, to: vb };
    }
    if (Object.keys(changes).length > 0) out.push({ path, kind: 'changed', changes });
    diffNodes(na.children ?? [], nb.children ?? [], path, out);
  }
}

/**
 * Diff of two snapshots. Returns an empty array for identical scenes.
 *
 * Siblings are paired by {@link SnapshotNode.key} where every key on a level is
 * unique, and by child index otherwise. Never by entity id: ids are regenerated
 * every run, so keying on them would make every cross-run diff total.
 *
 * The keyed path (`root > Row{k:row-42}`) is stable under reordering, which is
 * the point: an index path renames every sibling after an insertion, so the
 * diff describes different nodes than the ones that changed.
 */
export function diffSnapshots(a: SceneSnapshot, b: SceneSnapshot): SnapshotDiff[] {
  const out: SnapshotDiff[] = [];
  diffNodes(a.root, b.root, 'root', out);
  diffNodes(a.overlay, b.overlay, 'overlay', out);
  return out;
}
