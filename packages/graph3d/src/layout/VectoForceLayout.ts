import type { GraphData } from '../types';
import type { GraphLayout } from './GraphLayout';

/** Tuning for {@link VectoForceLayout}. All optional; defaults give a stable,
 *  3d-force-graph-like feel without depending on d3-force-3d. */
export interface VectoForceLayoutOptions {
  /** Resting length of a link's spring. Default 30. */
  linkDistance?: number;
  /** Link spring stiffness in `[0, 1]` (fraction of the overshoot corrected per
   *  tick, scaled by alpha). Default 0.3. */
  linkStrength?: number;
  /** Repulsion magnitude; larger pushes nodes further apart. Mirrors d3's
   *  negative "charge" but expressed as a positive strength. Default 300 —
   *  strong enough that unlinked nodes settle further apart than a link's
   *  resting length (`linkDistance`), matching the intuitive "connected =
   *  closer" feel. */
  repulsion?: number;
  /** Pull toward the origin, keeping the graph centered. Default 0.02. */
  centerStrength?: number;
  /** Per-tick velocity retention in `[0, 1)` (1 - friction). Default 0.6. */
  velocityDecay?: number;
  /** Barnes-Hut opening angle: a cell is treated as a single point when
   *  `size / distance < theta`. 0 = exact O(N²); larger = faster/looser.
   *  Default 0.9. */
  theta?: number;
  /** Alpha (temperature) decay per tick toward 0. Default 0.0228 (d3's default,
   *  ≈ 1 - 0.001^(1/300): ~300 ticks to cool). */
  alphaDecay?: number;
  /** Alpha below which {@link VectoForceLayout.step} reports "cooled". Default
   *  0.001. */
  alphaMin?: number;
  /** Deterministic seed for initial placement of un-seeded nodes. Default 1. */
  seed?: number;
}

const f = Math.fround;

/**
 * An in-house, dependency-free 3D force-directed graph layout.
 *
 * This is a **new force model**, not a d3-force-3d adapter: repulsion is an
 * in-house **Barnes-Hut octree** N-body (O(N log N) per tick instead of the
 * O(N²) a naive all-pairs charge would cost), combined with link springs, an
 * origin-centering pull, velocity-decay integration, and alpha cooling. It is
 * deterministic (a seeded PRNG places un-seeded nodes), self-contained, and
 * keeps positions and velocities in **f32** to match the exposed
 * `Float32Array` position buffer — while the Barnes-Hut octree accumulates
 * centers of mass and computes the repulsion integral in **f64**. A future
 * Rust/WASM kernel differential-tested bit-for-bit against this reference
 * (the canonical JS fallback) must therefore reproduce the f64 accumulation
 * exactly.
 *
 * Not bit-compatible with `D3ForceLayout` (a different model); it is offered as
 * an alternative {@link GraphLayout}, tuned to feel similar.
 */
export class VectoForceLayout implements GraphLayout {
  public positions: Float32Array = new Float32Array(0);

  private readonly linkDistance: number;
  private readonly linkStrength: number;
  private readonly repulsion: number;
  private readonly centerStrength: number;
  private readonly velocityDecay: number;
  private readonly theta: number;
  private readonly alphaDecay: number;
  private readonly alphaMin: number;
  private readonly seed: number;

  // SoA simulation state (f32), index-aligned with the input node array.
  private vx = new Float32Array(0);
  private vy = new Float32Array(0);
  private vz = new Float32Array(0);
  // Pins: NaN = free, else clamps the coordinate.
  private fx = new Float32Array(0);
  private fy = new Float32Array(0);
  private fz = new Float32Array(0);
  // Links as index pairs into the position buffer.
  private linkA = new Int32Array(0);
  private linkB = new Int32Array(0);
  private count = 0;
  private alpha = 1;
  private disposed = false;

  // Barnes-Hut octree scratch (grown as needed, reused across ticks).
  private tree = new BarnesHutOctree();

  constructor(options: VectoForceLayoutOptions = {}) {
    this.linkDistance = options.linkDistance ?? 30;
    this.linkStrength = options.linkStrength ?? 0.3;
    this.repulsion = options.repulsion ?? 300;
    this.centerStrength = options.centerStrength ?? 0.02;
    this.velocityDecay = options.velocityDecay ?? 0.6;
    this.theta = options.theta ?? 0.9;
    this.alphaDecay = options.alphaDecay ?? 0.0228;
    this.alphaMin = options.alphaMin ?? 0.001;
    this.seed = options.seed ?? 1;
  }

  public setGraph(data: GraphData): void {
    this.assertUsable();
    const n = data.nodes.length;
    this.count = n;
    this.positions = new Float32Array(n * 3);
    this.vx = new Float32Array(n);
    this.vy = new Float32Array(n);
    this.vz = new Float32Array(n);
    this.fx = new Float32Array(n);
    this.fy = new Float32Array(n);
    this.fz = new Float32Array(n);
    this.alpha = 1;

    // Deterministic seeded spherical placement for un-seeded nodes, so a given
    // graph always lays out the same way (needed for reproducible tests + the
    // future WASM differential oracle).
    const rand = mulberry32(this.seed >>> 0);
    for (let i = 0; i < n; i++) {
      const node = data.nodes[i];
      // Spherical shell of radius ∝ ∛i keeps initial density roughly uniform.
      const r = 10 * Math.cbrt(i + 1);
      const theta = rand() * Math.PI * 2;
      const phi = Math.acos(2 * rand() - 1);
      const seededX = node.x ?? r * Math.sin(phi) * Math.cos(theta);
      const seededY = node.y ?? r * Math.sin(phi) * Math.sin(theta);
      const seededZ = node.z ?? r * Math.cos(phi);
      this.positions[i * 3] = f(node.fx ?? seededX);
      this.positions[i * 3 + 1] = f(node.fy ?? seededY);
      this.positions[i * 3 + 2] = f(node.fz ?? seededZ);
      this.fx[i] = node.fx ?? NaN;
      this.fy[i] = node.fy ?? NaN;
      this.fz[i] = node.fz ?? NaN;
    }

    // Resolve link endpoints (id → index) once.
    const indexOf = new Map<GraphData['nodes'][number]['id'], number>();
    for (let i = 0; i < n; i++) indexOf.set(data.nodes[i].id, i);
    const a: number[] = [];
    const b: number[] = [];
    for (const link of data.links) {
      const ia = indexOf.get(link.source as never);
      const ib = indexOf.get(link.target as never);
      if (ia === undefined || ib === undefined || ia === ib) continue;
      a.push(ia);
      b.push(ib);
    }
    this.linkA = Int32Array.from(a);
    this.linkB = Int32Array.from(b);
  }

  public step(iterations = 1): boolean {
    this.assertUsable();
    if (this.count === 0) return false; // nothing to simulate → "cooled"
    for (let it = 0; it < iterations && this.alpha >= this.alphaMin; it++) {
      this.tick();
    }
    return this.alpha >= this.alphaMin;
  }

  /** One integration step. Public-ish for the differential harness; callers use
   *  {@link step}. */
  private tick(): void {
    const n = this.count;
    if (n === 0) return;
    const pos = this.positions;
    const alpha = this.alpha;

    // 1. Repulsion via Barnes-Hut octree (O(N log N)).
    this.tree.build(pos, n);
    const rep = f(this.repulsion * alpha);
    for (let i = 0; i < n; i++) {
      const [ax, ay, az] = this.tree.force(
        pos[i * 3],
        pos[i * 3 + 1],
        pos[i * 3 + 2],
        this.theta,
        i,
      );
      this.vx[i] = f(this.vx[i] + f(ax * rep));
      this.vy[i] = f(this.vy[i] + f(ay * rep));
      this.vz[i] = f(this.vz[i] + f(az * rep));
    }

    // 2. Link springs: pull each endpoint toward the resting length.
    const k = f(this.linkStrength * alpha);
    for (let l = 0; l < this.linkA.length; l++) {
      const ia = this.linkA[l];
      const ib = this.linkB[l];
      const dx = f(pos[ib * 3] - pos[ia * 3]);
      const dy = f(pos[ib * 3 + 1] - pos[ia * 3 + 1]);
      const dz = f(pos[ib * 3 + 2] - pos[ia * 3 + 2]);
      const dist = f(Math.sqrt(f(f(f(dx * dx) + f(dy * dy)) + f(dz * dz)))) || 1e-6;
      // Fraction of the overshoot to correct, split evenly between endpoints.
      const disp = f(f(f(dist - this.linkDistance) / dist) * k);
      const hx = f(f(dx * disp) * 0.5);
      const hy = f(f(dy * disp) * 0.5);
      const hz = f(f(dz * disp) * 0.5);
      this.vx[ia] = f(this.vx[ia] + hx);
      this.vy[ia] = f(this.vy[ia] + hy);
      this.vz[ia] = f(this.vz[ia] + hz);
      this.vx[ib] = f(this.vx[ib] - hx);
      this.vy[ib] = f(this.vy[ib] - hy);
      this.vz[ib] = f(this.vz[ib] - hz);
    }

    // 3. Centering pull toward the origin + 4. integrate with velocity decay +
    // 5. honor pins.
    const c = f(this.centerStrength * alpha);
    const decay = this.velocityDecay;
    for (let i = 0; i < n; i++) {
      let px = pos[i * 3];
      let py = pos[i * 3 + 1];
      let pz = pos[i * 3 + 2];
      let nvx = f(f(this.vx[i] - f(px * c)) * decay);
      let nvy = f(f(this.vy[i] - f(py * c)) * decay);
      let nvz = f(f(this.vz[i] - f(pz * c)) * decay);

      if (!Number.isNaN(this.fx[i])) {
        px = this.fx[i];
        nvx = 0;
      } else px = f(px + nvx);
      if (!Number.isNaN(this.fy[i])) {
        py = this.fy[i];
        nvy = 0;
      } else py = f(py + nvy);
      if (!Number.isNaN(this.fz[i])) {
        pz = this.fz[i];
        nvz = 0;
      } else pz = f(pz + nvz);

      pos[i * 3] = px;
      pos[i * 3 + 1] = py;
      pos[i * 3 + 2] = pz;
      this.vx[i] = nvx;
      this.vy[i] = nvy;
      this.vz[i] = nvz;
    }

    // 6. Cool.
    this.alpha = this.alpha + (0 - this.alpha) * this.alphaDecay;
  }

  public pinNode(nodeIndex: number, x: number, y: number, z: number): void {
    this.assertUsable();
    if (nodeIndex < 0 || nodeIndex >= this.count) return;
    this.fx[nodeIndex] = x;
    this.fy[nodeIndex] = y;
    this.fz[nodeIndex] = z;
    this.positions[nodeIndex * 3] = f(x);
    this.positions[nodeIndex * 3 + 1] = f(y);
    this.positions[nodeIndex * 3 + 2] = f(z);
    this.vx[nodeIndex] = 0;
    this.vy[nodeIndex] = 0;
    this.vz[nodeIndex] = 0;
  }

  public unpinNode(nodeIndex: number): void {
    this.assertUsable();
    if (nodeIndex < 0 || nodeIndex >= this.count) return;
    this.fx[nodeIndex] = NaN;
    this.fy[nodeIndex] = NaN;
    this.fz[nodeIndex] = NaN;
  }

  public reheat(alpha = 0.3): void {
    this.assertUsable();
    this.alpha = Math.max(this.alphaMin, Math.min(1, alpha));
  }

  public dispose(): void {
    this.disposed = true;
    this.positions = new Float32Array(0);
    this.vx = this.vy = this.vz = new Float32Array(0);
    this.fx = this.fy = this.fz = new Float32Array(0);
    this.linkA = this.linkB = new Int32Array(0);
    this.count = 0;
  }

  private assertUsable(): void {
    if (this.disposed) throw new Error('VectoForceLayout was disposed');
  }
}

/** Deterministic 32-bit PRNG (mulberry32) — small, fast, seedable. */
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A 3D Barnes-Hut octree over the node positions. `build` inserts every point
 * and computes each cell's mass (point count) + center of mass; `force`
 * accumulates the repulsion on a query point, treating a cell as a single
 * pseudo-particle when it is far enough away (`cellSize / distance < theta`).
 * Nodes and mass/CoM arrays are flat and reused across ticks.
 */
class BarnesHutOctree {
  // Node arrays (flat). A node is a leaf if it has <= 1 point (childStart < 0).
  private cx = new Float64Array(0); // center of mass x
  private cy = new Float64Array(0);
  private cz = new Float64Array(0);
  private mass = new Float64Array(0); // point count
  private size = new Float64Array(0); // cell edge length
  private child = new Int32Array(0); // 8 children per node, -1 = empty
  private pointIndex = new Int32Array(0); // point index stored in a leaf, -1 = internal
  private nodeCount = 0;
  private capacity = 0;

  build(pos: Float32Array, n: number): void {
    // Root bounds: cube enclosing all points.
    let min = Infinity;
    let max = -Infinity;
    for (let i = 0; i < n * 3; i++) {
      const v = pos[i];
      if (v < min) min = v;
      if (v > max) max = v;
    }
    if (!Number.isFinite(min)) {
      min = -1;
      max = 1;
    }
    const edge = Math.max(max - min, 1e-3);
    const cxRoot = (min + max) / 2;

    this.ensure(n);
    this.nodeCount = 1;
    this.resetNode(0, cxRoot, cxRoot, cxRoot, edge);
    // Reinterpret root center as the actual center (cube centered on midpoint of
    // each axis; points share the same [min,max] cube for simplicity).
    this.cx[0] = cxRoot;
    this.cy[0] = cxRoot;
    this.cz[0] = cxRoot;

    for (let i = 0; i < n; i++) {
      this.insert(0, pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2], cxRoot, cxRoot, cxRoot, edge, i);
    }
    this.finalizeMass(pos, n);
  }

  private ensure(n: number): void {
    // Worst case an octree needs up to ~2N internal nodes; allocate generously.
    const need = Math.max(64, n * 8 + 8);
    if (need <= this.capacity) return;
    this.capacity = need;
    this.cx = new Float64Array(need);
    this.cy = new Float64Array(need);
    this.cz = new Float64Array(need);
    this.mass = new Float64Array(need);
    this.size = new Float64Array(need);
    this.child = new Int32Array(need * 8);
    this.pointIndex = new Int32Array(need);
    // Per-node stored point (leaf) coordinates.
    this.px = new Float64Array(need);
    this.py = new Float64Array(need);
    this.pz = new Float64Array(need);
    this.hasPoint = new Uint8Array(need);
  }

  /**
   * Allocate the next node index, growing the flat arrays first when the
   * tree has outgrown them. The 8n+8 bound in {@link ensure} assumes ~2N
   * internal nodes, but a pathological insert path can create up to one node
   * per depth level (40) per point — writing past the typed-array end is
   * silently dropped, which left the fresh node holding reused garbage from
   * a previous tick and produced NaN forces.
   */
  private allocateNode(cx: number, cy: number, cz: number, size: number): number {
    if (this.nodeCount >= this.capacity) this.grow();
    const node = this.nodeCount++;
    this.resetNode(node, cx, cy, cz, size);
    return node;
  }

  private grow(): void {
    const next = Math.max(this.capacity * 2, 64);
    this.capacity = next;
    this.cx = BarnesHutOctree.resized(this.cx, next);
    this.cy = BarnesHutOctree.resized(this.cy, next);
    this.cz = BarnesHutOctree.resized(this.cz, next);
    this.mass = BarnesHutOctree.resized(this.mass, next);
    this.size = BarnesHutOctree.resized(this.size, next);
    this.px = BarnesHutOctree.resized(this.px, next);
    this.py = BarnesHutOctree.resized(this.py, next);
    this.pz = BarnesHutOctree.resized(this.pz, next);
    this.hasPoint = BarnesHutOctree.resized(this.hasPoint, next);
    this.pointIndex = BarnesHutOctree.resized(this.pointIndex, next);
    this.child = BarnesHutOctree.resized(this.child, next * 8);
  }

  private static resized<T extends Float64Array | Int32Array | Uint8Array>(
    src: T,
    length: number,
  ): T {
    const out = new (src.constructor as new (n: number) => T)(length);
    out.set(src);
    return out;
  }

  private px = new Float64Array(0);
  private py = new Float64Array(0);
  private pz = new Float64Array(0);
  private hasPoint = new Uint8Array(0);

  private resetNode(node: number, cx: number, cy: number, cz: number, size: number): void {
    this.size[node] = size;
    this.mass[node] = 0;
    this.hasPoint[node] = 0;
    this.pointIndex[node] = -1;
    // Cell geometric center is tracked implicitly via the insertion path; store
    // it in cx/cy/cz temporarily (overwritten with center of mass in finalize).
    this.cx[node] = cx;
    this.cy[node] = cy;
    this.cz[node] = cz;
    for (let k = 0; k < 8; k++) this.child[node * 8 + k] = -1;
  }

  /** Insert a point into the subtree rooted at `node` whose cell is centered at
   *  (gcx,gcy,gcz) with edge `size`. `pointIndex` seeds the deterministic
   *  jitter used to keep exactly-coincident points as distinct leaves. */
  private insert(
    node: number,
    x: number,
    y: number,
    z: number,
    gcx: number,
    gcy: number,
    gcz: number,
    size: number,
    pointIndex: number,
  ): void {
    // Descend until an empty or leaf cell.
    let curr = node;
    let ccx = gcx;
    let ccy = gcy;
    let ccz = gcz;
    let csize = size;
    // Guard against pathological deep recursion (coincident points).
    for (let depth = 0; depth < 40; depth++) {
      if (this.hasPoint[curr] === 0 && this.child[curr * 8] === -1) {
        // Empty leaf: store the point here.
        this.px[curr] = x;
        this.py[curr] = y;
        this.pz[curr] = z;
        this.hasPoint[curr] = 1;
        this.pointIndex[curr] = pointIndex;
        return;
      }
      if (this.hasPoint[curr] === 1) {
        // Occupied leaf: push the existing point down, then continue for ours.
        let ox = this.px[curr];
        let oy = this.py[curr];
        let oz = this.pz[curr];
        const oi = this.pointIndex[curr];
        this.hasPoint[curr] = 0;
        this.pointIndex[curr] = -1;
        if (Math.abs(ox - x) < 1e-9 && Math.abs(oy - y) < 1e-9 && Math.abs(oz - z) < 1e-9) {
          // Exactly-coincident points would split into the same octant
          // forever. Collapsing them into one leaf (the old behaviour) was
          // wrong: the cluster's mass was undercounted, and two coincident
          // UNLINKED nodes feel identical spring (none) and centering forces,
          // so nothing ever separated them. Jitter BOTH points — the stored
          // one too, so neither leaf sits exactly at the true position where
          // force() could not resolve a direction — with tiny deterministic,
          // index-derived offsets: identical inputs jitter identically, both
          // points stay in the tree, and the repulsion pair separates them.
          const [sx, sy, sz] = BarnesHutOctree.jitterFor(oi);
          ox += sx;
          oy += sy;
          oz += sz;
          const [jx, jy, jz] = BarnesHutOctree.jitterFor(pointIndex);
          x += jx;
          y += jy;
          z += jz;
        }
        this.placeChild(curr, ox, oy, oz, ccx, ccy, ccz, csize, oi);
      }
      // Route our point into the appropriate child octant.
      const oct = (x >= ccx ? 1 : 0) | (y >= ccy ? 2 : 0) | (z >= ccz ? 4 : 0);
      const half = csize / 2;
      const nccx = ccx + (oct & 1 ? half / 2 : -half / 2);
      const nccy = ccy + (oct & 2 ? half / 2 : -half / 2);
      const nccz = ccz + (oct & 4 ? half / 2 : -half / 2);
      let childNode = this.child[curr * 8 + oct];
      if (childNode === -1) {
        childNode = this.allocateNode(nccx, nccy, nccz, half);
        this.child[curr * 8 + oct] = childNode;
      }
      curr = childNode;
      ccx = nccx;
      ccy = nccy;
      ccz = nccz;
      csize = half;
    }
  }

  /**
   * A deterministic ~1e-4-magnitude direction derived purely from the point
   * index (pure integer mulberry32 draws, so it is bit-identical on every
   * platform — the determinism contract of {@link VectoForceLayout}).
   */
  private static jitterFor(i: number): [number, number, number] {
    let a = (i + 1) | 0;
    const next = () => {
      a |= 0;
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const x = next() - 0.5;
    const y = next() - 0.5;
    const z = next() - 0.5;
    const len = Math.hypot(x, y, z) || 1;
    const scale = 1e-4 / len;
    return [x * scale, y * scale, z * scale];
  }

  /** Place an existing leaf point into a child octant of `node`. */
  private placeChild(
    node: number,
    x: number,
    y: number,
    z: number,
    ccx: number,
    ccy: number,
    ccz: number,
    csize: number,
    pointIndex: number,
  ): void {
    const oct = (x >= ccx ? 1 : 0) | (y >= ccy ? 2 : 0) | (z >= ccz ? 4 : 0);
    const half = csize / 2;
    const nccx = ccx + (oct & 1 ? half / 2 : -half / 2);
    const nccy = ccy + (oct & 2 ? half / 2 : -half / 2);
    const nccz = ccz + (oct & 4 ? half / 2 : -half / 2);
    let childNode = this.child[node * 8 + oct];
    if (childNode === -1) {
      childNode = this.allocateNode(nccx, nccy, nccz, half);
      this.child[node * 8 + oct] = childNode;
    }
    this.px[childNode] = x;
    this.py[childNode] = y;
    this.pz[childNode] = z;
    this.hasPoint[childNode] = 1;
    this.pointIndex[childNode] = pointIndex;
  }

  /** Compute mass + center of mass for every node, bottom-up. Because nodes are
   *  allocated in insertion (top-down) order, a reverse pass visits children
   *  before parents. */
  private finalizeMass(_pos: Float32Array, _n: number): void {
    for (let node = this.nodeCount - 1; node >= 0; node--) {
      if (this.hasPoint[node] === 1) {
        this.mass[node] = 1;
        this.cx[node] = this.px[node];
        this.cy[node] = this.py[node];
        this.cz[node] = this.pz[node];
        continue;
      }
      let m = 0;
      let sx = 0;
      let sy = 0;
      let sz = 0;
      for (let k = 0; k < 8; k++) {
        const c = this.child[node * 8 + k];
        if (c === -1) continue;
        const cm = this.mass[c];
        m += cm;
        sx += this.cx[c] * cm;
        sy += this.cy[c] * cm;
        sz += this.cz[c] * cm;
      }
      this.mass[node] = m;
      if (m > 0) {
        this.cx[node] = sx / m;
        this.cy[node] = sy / m;
        this.cz[node] = sz / m;
      }
    }
  }

  /** Repulsion acceleration on a query point, as an inverse-square push away
   *  from every other point, approximated via the octree. Returns a unit-ish
   *  direction * magnitude vector (the caller scales by repulsion * alpha).
   *  `pointIndex` identifies the query point so its own leaf can be skipped
   *  by identity rather than by distance — exactly-coincident distinct points
   *  are stored as jittered leaves and must still exert force on each other. */
  force(
    qx: number,
    qy: number,
    qz: number,
    theta: number,
    pointIndex: number,
  ): [number, number, number] {
    let ax = 0;
    let ay = 0;
    let az = 0;
    // Iterative stack traversal to avoid recursion overhead.
    const stack = this._stack;
    let sp = 0;
    stack[sp++] = 0;
    while (sp > 0) {
      const node = stack[--sp];
      const m = this.mass[node];
      if (m === 0) continue;
      const dx = this.cx[node] - qx;
      const dy = this.cy[node] - qy;
      const dz = this.cz[node] - qz;
      let d2 = dx * dx + dy * dy + dz * dz;
      const isLeaf = this.hasPoint[node] === 1;
      // Opening criterion: treat the cell as one pseudo-particle when small
      // relative to distance, or when it's a single-point leaf.
      if (isLeaf || this.size[node] * this.size[node] < theta * theta * d2) {
        // The query point's own leaf: a point exerts no force on itself.
        // Identity is the only sound test — d2 === 0 would also skip the
        // jittered leaf of a coincident *other* point, whose distance to the
        // stored query position is not the leaf separation.
        if (isLeaf && this.pointIndex[node] === pointIndex) continue;
        if (d2 < 1e-6) {
          // Near-coincident leaves get the floor instead, which caps the
          // 1/d³ blow-up while still pushing them apart strongly.
          d2 = 1e-6;
        }
        const invD = 1 / Math.sqrt(d2);
        const factor = -m * invD * invD * invD; // -m / d^3 (away from mass)
        ax += dx * factor;
        ay += dy * factor;
        az += dz * factor;
      } else {
        for (let k = 0; k < 8; k++) {
          const c = this.child[node * 8 + k];
          if (c !== -1) stack[sp++] = c;
        }
      }
    }
    return [ax, ay, az];
  }

  private _stack = new Int32Array(4096);
}
