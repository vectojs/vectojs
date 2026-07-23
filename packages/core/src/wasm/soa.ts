/**
 * SoA transform store and the JS reference composer.
 *
 * This is the data-layout half of the Rust/WASM transform core. `buildStore`
 * turns a tree into the pure Structure-of-Arrays layout the WASM kernel
 * (`crates/vectojs-core-rs`) requires, and `composeJS` computes world matrices
 * over that same layout in TypeScript. The two MUST produce bit-identical f64
 * results — `composeJS` is both the correctness oracle for the differential
 * test and the permanent fallback when WASM is unavailable (CSP, no SIMD,
 * missing asset). Neither this file nor the loader touches `Entity`/`Scene`;
 * wiring them into the render walk is the gated integration step (see the task
 * plan), so this layer ships and is tested on its own.
 *
 * ## Why the layout is shaped this way
 *
 * - **Pure SoA** (one flat array per field): consecutive entities' `x` values
 *   are adjacent, so a `v128` load fetches two at once. An interleaved record
 *   would put them 8*N bytes apart and make SIMD unreachable.
 * - **Contiguous sibling runs in depth order**: WASM SIMD has no gather, so the
 *   parent matrix must be loop-invariant across a run. `buildStore` emits every
 *   parent's children as one contiguous run and always emits a parent before
 *   its children, so a run's parent world matrix is already composed when the
 *   run is processed. The scene root is index 0 at the identity transform.
 */

/** A node's local transform (the six animatable scalars). */
export interface LocalTransform {
  x: number;
  y: number;
  scaleX: number;
  scaleY: number;
  rotation: number;
  opacity: number;
}

/**
 * One input node. `parent` is an index into the input array, or `-1` for the
 * single root. Input order is arbitrary; `buildStore` re-indexes into store
 * order (root at 0, then depth-ordered contiguous sibling runs).
 */
export interface InputNode extends LocalTransform {
  parent: number;
}

/** A composed world matrix (`a b c d e f`) plus accumulated opacity. */
export interface WorldMatrix {
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
  opacity: number;
}

/**
 * The SoA store: input fields, output world-matrix fields, and the sibling-run
 * table. Field arrays are sized `count + 8` so a 2-lane SIMD tail can read one
 * slot past the logical end without a scalar remainder loop (mirrors the
 * crate's `+8` padding). `storeIndexOf[k]` maps input index `k` to store index.
 */
export interface TransformStore {
  count: number;
  capacity: number;
  // Inputs.
  x: Float64Array;
  y: Float64Array;
  sx: Float64Array;
  sy: Float64Array;
  cos: Float64Array;
  sin: Float64Array;
  opacity: Float64Array;
  // Outputs.
  wa: Float64Array;
  wb: Float64Array;
  wc: Float64Array;
  wd: Float64Array;
  we: Float64Array;
  wf: Float64Array;
  wo: Float64Array;
  // Sibling runs.
  runParent: Int32Array;
  runStart: Int32Array;
  runLen: Int32Array;
  runCount: number;
  // input index -> store index.
  storeIndexOf: Int32Array;
}

const PAD = 8;

/**
 * Build the SoA store from a node list. Exactly one node must have
 * `parent === -1` (the root); it becomes store index 0 at the identity world
 * transform (its own local transform is ignored, matching how `Scene` leaves
 * root/overlayRoot at identity). Throws on a missing or duplicate root.
 *
 * Emission is BFS per parent: dequeue a parent, emit ALL its children as one
 * contiguous run, enqueue them. This guarantees (a) each parent's children are
 * contiguous — required for SIMD — and (b) a parent is assigned a lower store
 * index and composed before its children.
 *
 * Time: O(n). Space: O(n).
 */
export function buildStore(nodes: InputNode[]): TransformStore {
  const count = nodes.length;
  const capacity = count + PAD;

  // Group children by parent (input indices).
  const childrenOf: number[][] = Array.from({ length: count }, () => []);
  let rootInput = -1;
  for (let k = 0; k < count; k++) {
    const p = nodes[k].parent;
    if (p === -1) {
      if (rootInput !== -1) throw new Error('buildStore: more than one root (parent === -1)');
      rootInput = k;
    } else {
      if (p < 0 || p >= count)
        throw new Error(`buildStore: node ${k} has out-of-range parent ${p}`);
      childrenOf[p].push(k);
    }
  }
  if (rootInput === -1) throw new Error('buildStore: no root (need exactly one parent === -1)');

  const store: TransformStore = {
    count,
    capacity,
    x: new Float64Array(capacity),
    y: new Float64Array(capacity),
    sx: new Float64Array(capacity),
    sy: new Float64Array(capacity),
    cos: new Float64Array(capacity),
    sin: new Float64Array(capacity),
    opacity: new Float64Array(capacity),
    wa: new Float64Array(capacity),
    wb: new Float64Array(capacity),
    wc: new Float64Array(capacity),
    wd: new Float64Array(capacity),
    we: new Float64Array(capacity),
    wf: new Float64Array(capacity),
    wo: new Float64Array(capacity),
    runParent: new Int32Array(count),
    runStart: new Int32Array(count),
    runLen: new Int32Array(count),
    runCount: 0,
    storeIndexOf: new Int32Array(count).fill(-1),
  };

  // Root -> store index 0. Its input fields are unused (kernel seeds identity),
  // but fill them so the padding/root slot holds defined values.
  store.storeIndexOf[rootInput] = 0;
  writeInput(store, 0, nodes[rootInput]);

  let next = 1;
  const queue: number[] = [rootInput];
  let head = 0;
  while (head < queue.length) {
    const parentInput = queue[head++];
    const kids = childrenOf[parentInput];
    if (kids.length === 0) continue;

    const runStart = next;
    for (const kid of kids) {
      store.storeIndexOf[kid] = next;
      writeInput(store, next, nodes[kid]);
      next++;
    }
    const r = store.runCount++;
    store.runParent[r] = store.storeIndexOf[parentInput];
    store.runStart[r] = runStart;
    store.runLen[r] = kids.length;
    for (const kid of kids) queue.push(kid);
  }

  return store;
}

function writeInput(s: TransformStore, i: number, n: LocalTransform): void {
  s.x[i] = n.x;
  s.y[i] = n.y;
  s.sx[i] = n.scaleX;
  s.sy[i] = n.scaleY;
  s.cos[i] = Math.cos(n.rotation);
  s.sin[i] = Math.sin(n.rotation);
  s.opacity[i] = n.opacity;
}

/**
 * Compose world matrices over the store in TypeScript — the reference oracle
 * and the permanent JS fallback. Bit-identical to the crate's `compose_scalar`:
 * same Canvas `T * S * R` order, same operation order, same f64 arithmetic.
 * Seeds the root (index 0) to identity, then walks runs in order.
 */
export function composeJS(s: TransformStore): void {
  s.wa[0] = 1;
  s.wb[0] = 0;
  s.wc[0] = 0;
  s.wd[0] = 1;
  s.we[0] = 0;
  s.wf[0] = 0;
  s.wo[0] = 1;

  for (let r = 0; r < s.runCount; r++) {
    const p = s.runParent[r];
    const start = s.runStart[r];
    const len = s.runLen[r];

    const pa = s.wa[p];
    const pb = s.wb[p];
    const pc = s.wc[p];
    const pd = s.wd[p];
    const pe = s.we[p];
    const pf = s.wf[p];
    const po = s.wo[p];

    for (let i = start; i < start + len; i++) {
      const x = s.x[i];
      const y = s.y[i];
      const sx = s.sx[i];
      const sy = s.sy[i];
      const cos = s.cos[i];
      const sin = s.sin[i];

      const te = pa * x + pc * y + pe;
      const tf = pb * x + pd * y + pf;
      const sxCos = sx * cos;
      const sxSin = sx * sin;
      const syCos = sy * cos;
      const sySin = sy * sin;
      s.wa[i] = pa * sxCos + pc * sySin;
      s.wb[i] = pb * sxCos + pd * sySin;
      s.wc[i] = pa * -sxSin + pc * syCos;
      s.wd[i] = pb * -sxSin + pd * syCos;
      s.we[i] = te;
      s.wf[i] = tf;
      s.wo[i] = po * s.opacity[i];
    }
  }
}

/** Read the world matrix at store index `i`. */
export function readWorld(s: TransformStore, i: number): WorldMatrix {
  return {
    a: s.wa[i],
    b: s.wb[i],
    c: s.wc[i],
    d: s.wd[i],
    e: s.we[i],
    f: s.wf[i],
    opacity: s.wo[i],
  };
}
