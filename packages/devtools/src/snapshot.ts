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
  children?: SnapshotNode[];
}

export interface SceneSnapshot {
  width: number;
  height: number;
  root: SnapshotNode[];
  overlay: SnapshotNode[];
}

export interface SnapshotDiff {
  /** Structural path, e.g. `root > Card[0] > Text[2]` — ids are random per run, paths are not. */
  path: string;
  kind: 'added' | 'removed' | 'changed';
  changes?: Record<string, { from: unknown; to: unknown }>;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

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

function pathOf(parent: string, node: SnapshotNode, index: number): string {
  return `${parent} > ${node.type}[${index}]`;
}

function diffNodes(
  a: SnapshotNode[],
  b: SnapshotNode[],
  parent: string,
  out: SnapshotDiff[],
): void {
  const max = Math.max(a.length, b.length);
  for (let i = 0; i < max; i++) {
    const na = a[i];
    const nb = b[i];
    if (na && !nb) {
      out.push({ path: pathOf(parent, na, i), kind: 'removed' });
      continue;
    }
    if (!na && nb) {
      out.push({ path: pathOf(parent, nb, i), kind: 'added' });
      continue;
    }
    if (!na || !nb) continue;
    const path = pathOf(parent, nb, i);
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
 * Structural diff of two snapshots, keyed by tree path (never by entity id —
 * ids are regenerated every run). Returns an empty array for identical scenes.
 */
export function diffSnapshots(a: SceneSnapshot, b: SceneSnapshot): SnapshotDiff[] {
  const out: SnapshotDiff[] = [];
  diffNodes(a.root, b.root, 'root', out);
  diffNodes(a.overlay, b.overlay, 'overlay', out);
  return out;
}
