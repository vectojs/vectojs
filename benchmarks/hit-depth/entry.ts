// CTX-0309 — is `isHitEligible()`'s ancestor walk a measured query cost on DEEP
// scenes? This is the gate for the "flatten effective hit state during transform
// gather" research entry, which had never been measured.
//
// Why a new bench rather than `scene-hit-wasm`: that one answers "does the WASM
// grid beat the JS walk", and every entity in it is `scene.add(e)` — depth 1. A
// flat scene cannot exercise an ancestor walk at all, so it cannot answer this
// gate's question. Here depth is the swept variable and entity count is held
// fixed, so any change in query cost is attributable to depth alone.
//
// What the entry proposes to build is a cache: store effective opacity, pointer
// enablement and clip bounds during transform gather, so the query reads one
// flat record instead of walking. Its stop condition is "only if the integrated
// query wins", so this measures BOTH:
//   walk      — today's `isHitEligible`, climbing `parent` per confirmed hit
//   flattened — the proposed alternative, an O(1) read of a precomputed record
// Measuring only the walk would give a number with nothing to compare it to,
// which is how a share-of-a-small-total gets mistaken for a bottleneck.
//
// The walk runs ONLY on the WASM-grid path (HitTester.ts:225,233), and only for
// a candidate that already passed its AABB and `isPointInside`. So the realistic
// worst case is a deep chain of `clipChildren` ancestors that all CONTAIN the
// point — an early `return false` would exit the loop before doing the work.
// Both a contains-all chain and a mixed chain are measured; the first is the
// pessimistic bound, the second is what a real UI looks like.
import { Entity, Scene } from '@vectojs/core';
import { awaitStart, reportFailure, reportResult } from '../_shared/client.ts';
import { median } from '../_shared/stats.ts';

const p = new URLSearchParams(location.search);
/** Ancestor chain depths to sweep. Depth 1 reproduces the flat case. */
const DEPTHS = (p.get('depths') ?? '1,4,8,16,32,64').split(',').map(Number);
/** Queries per timed region — a hover-tracking burst against one frame. */
const QUERIES = Number(p.get('queries') ?? 2000);
const TRIALS = Number(p.get('trials') ?? 7);
/** `contains` (pessimistic: every clip ancestor contains the point) or `mixed`. */
const SHAPE = p.get('shape') ?? 'both';

const VW = 1280;
const VH = 800;

class Box extends Entity {
  width = 1;
  height = 1;
  constructor(
    id: string,
    public w: number,
    public h: number,
  ) {
    super(id);
    this.width = w;
    this.height = h;
  }
  getBounds() {
    return { x: 0, y: 0, width: this.w, height: this.h };
  }
  isPointInside(gx: number, gy: number): boolean {
    const local = this.worldToLocal(gx, gy);
    if (!local) return false;
    return local.x >= 0 && local.x <= this.w && local.y <= this.h && local.y >= 0;
  }
  render(): void {}
}

/**
 * A chain of `depth` nested containers with one leaf at the bottom. Every
 * container is `clipChildren` and sized to cover the viewport, so in the
 * `contains` shape the point lies inside all of them and the walk runs to full
 * length without an early exit. In `mixed`, only every fourth ancestor clips,
 * which is closer to a real tree.
 */
function buildChain(scene: Scene, depth: number, shape: 'contains' | 'mixed'): Box {
  let parent: Entity | Scene = scene;
  let leaf: Box | null = null;
  for (let d = 0; d < depth; d++) {
    const node = new Box(`d${d}`, VW + 400, VH + 400);
    node.x = 0;
    node.y = 0;
    node.clipChildren = shape === 'contains' ? true : d % 4 === 0;
    parent.add(node);
    parent = node;
    leaf = node;
  }
  const target = new Box('leaf', 240, 120);
  target.x = 40;
  target.y = 40;
  if (leaf) leaf.add(target);
  else scene.add(target);
  return target;
}

/**
 * The proposed flattened read, standing in for what a transform-gather cache
 * would produce: one record per entity, consulted in O(1) with no tree access.
 * Deliberately computed BEFORE the timed region — the entry's premise is that
 * gather already walks the tree, so the flattened state is a by-product and its
 * construction is not new query-time cost. That assumption is stated here rather
 * than hidden, because it is the load-bearing one: if gather did NOT already
 * walk, this comparison would be unfair to the walk.
 */
interface FlatHitState {
  eligible: boolean;
  clipMinX: number;
  clipMinY: number;
  clipMaxX: number;
  clipMaxY: number;
}

function flattenFor(node: Entity): FlatHitState {
  let minX = -Infinity;
  let minY = -Infinity;
  let maxX = Infinity;
  let maxY = Infinity;
  let eligible = node.opacity > 0;
  for (let a: Entity | null = node.parent; a; a = a.parent) {
    if (a.opacity <= 0) eligible = false;
    if (a.clipChildren && a.width > 0 && a.height > 0) {
      const b = a.getWorldBounds();
      minX = Math.max(minX, b.x);
      minY = Math.max(minY, b.y);
      maxX = Math.min(maxX, b.x + b.width);
      maxY = Math.min(maxY, b.y + b.height);
    }
  }
  return { eligible, clipMinX: minX, clipMinY: minY, clipMaxX: maxX, clipMaxY: maxY };
}

function readFlat(s: FlatHitState, x: number, y: number): boolean {
  return s.eligible && x >= s.clipMinX && x <= s.clipMaxX && y >= s.clipMinY && y <= s.clipMaxY;
}

/**
 * Today's walk, reproduced exactly as `HitTester.isHitEligible` does it
 * (packages/core/src/tree/scene/HitTester.ts:298). Copied rather than called
 * because it is `private`; kept literally in step with the original, including
 * the `worldToLocal` per clipping ancestor, which is the actual cost.
 */
function walkEligible(node: Entity, x: number, y: number): boolean {
  const attrs = node.getA11yAttributes();
  if (attrs.disabled === true || attrs.pointerEvents === 'none') return false;
  if (node.opacity <= 0) return false;
  for (let ancestor: Entity | null = node.parent; ancestor; ancestor = ancestor.parent) {
    if (ancestor.opacity <= 0) return false;
    if (ancestor.clipChildren && ancestor.width > 0 && ancestor.height > 0) {
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
  }
  return true;
}

const yieldToBrowser = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

function timeNsPerQuery(trials: number, action: (i: number) => boolean): number {
  const per: number[] = [];
  for (let t = 0; t < trials; t++) {
    let sink = 0;
    const t0 = performance.now();
    for (let i = 0; i < QUERIES; i++) if (action(i)) sink++;
    const dt = performance.now() - t0;
    // Consume `sink` so the loop is not dead code the JIT can delete outright.
    if (sink === -1) throw new Error('unreachable');
    per.push((dt * 1e6) / QUERIES);
  }
  return median(per);
}

async function main(): Promise<void> {
  await awaitStart();
  const startedAt = performance.now();
  const canvas = document.createElement('canvas');
  canvas.width = VW;
  canvas.height = VH;
  document.body.appendChild(canvas);
  const pre = document.createElement('pre');
  pre.style.cssText = 'font:12px monospace;white-space:pre-wrap';
  document.body.appendChild(pre);

  const shapes: Array<'contains' | 'mixed'> =
    SHAPE === 'both' ? ['contains', 'mixed'] : [SHAPE as 'contains' | 'mixed'];

  const rows: Array<Record<string, number | string>> = [];
  for (const shape of shapes) {
    for (const depth of DEPTHS) {
      const scene = new Scene(canvas, { disableWindowResize: true });
      scene.resize(VW, VH);
      const target = buildChain(scene, depth, shape);
      scene.step(16.67);

      // Query points inside the leaf, so every query is a CONFIRMED hit and the
      // walk runs — the case the gate is about. Varied so a single lucky
      // coordinate cannot dominate.
      const qx = new Float64Array(QUERIES);
      const qy = new Float64Array(QUERIES);
      for (let i = 0; i < QUERIES; i++) {
        qx[i] = 45 + (i % 200);
        qy[i] = 45 + (i % 100);
      }

      const flat = flattenFor(target);
      // Correctness before speed: the flattened read must agree with the walk on
      // every query, or the comparison is between two different questions.
      let disagreements = 0;
      for (let i = 0; i < QUERIES; i++) {
        if (walkEligible(target, qx[i], qy[i]) !== readFlat(flat, qx[i], qy[i])) disagreements++;
      }

      const walkNs = timeNsPerQuery(TRIALS, (i) => walkEligible(target, qx[i], qy[i]));
      await yieldToBrowser();
      const flatNs = timeNsPerQuery(TRIALS, (i) => readFlat(flat, qx[i], qy[i]));

      rows.push({
        shape,
        depth,
        clipAncestors: shape === 'contains' ? depth : Math.ceil(depth / 4),
        walkNsPerQuery: +walkNs.toFixed(1),
        flatNsPerQuery: +flatNs.toFixed(1),
        savedNsPerQuery: +(walkNs - flatNs).toFixed(1),
        speedup: +(walkNs / Math.max(flatNs, 1e-9)).toFixed(2),
        disagreements,
      });

      scene.destroy();
      await yieldToBrowser();
    }
  }

  pre.textContent = JSON.stringify(rows, null, 1);
  const result = await reportResult({
    name: 'hit-depth',
    // No real animation frames: this measures a synchronous query loop against
    // one settled scene, so LoAF would only report the harness's own blocking.
    syntheticFrames: true,
    params: {
      depths: DEPTHS,
      queries: QUERIES,
      trials: TRIALS,
      shape: SHAPE,
      dpr: devicePixelRatio,
      note: "Ancestor-walk cost in isHitEligible vs the proposed flattened O(1) read, sweeping ancestor depth with entity count fixed. `contains` makes every clipChildren ancestor contain the query point, so the walk runs to full length with no early exit (pessimistic bound); `mixed` clips every 4th ancestor. Every query is a confirmed hit on the leaf, because the walk only runs after AABB + isPointInside pass on the WASM-grid path. The flattened record is built before the timed region on the entry's own premise that transform gather already walks the tree.",
    },
    rows,
    durationMs: +(performance.now() - startedAt).toFixed(1),
  });
  pre.textContent = JSON.stringify(result, null, 2);
}

main().catch((e) => {
  void reportFailure('hit-depth', e);
});
