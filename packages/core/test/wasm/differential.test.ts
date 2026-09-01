import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  buildStore,
  composeJS,
  computeAabbsJS,
  type InputNode,
  type TransformStore,
} from '../../src/wasm/soa';
import { instantiateSync, type WasmTransformBackend } from '../../src/wasm/backend';

// The WASM asset is built by crates/vectojs-core-rs/build.sh and is gitignored
// (built in CI, published to npm, never committed). Contributors touching only
// TypeScript have no Rust toolchain and no .wasm — in that case this suite is
// skipped rather than failed, exactly as the JS path is a permanent fallback.
const wasmPath = fileURLToPath(new URL('../../src/wasm/vectojs_core.wasm', import.meta.url));
const haveWasm = existsSync(wasmPath);

// A tiny deterministic PRNG so a failure reproduces from its seed.
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

type Topology = 'flat' | 'chain' | 'bushy' | 'mixed';

function randomTree(count: number, topo: Topology, rand: () => number): InputNode[] {
  const nodes: InputNode[] = [];
  for (let k = 0; k < count; k++) {
    let parent: number;
    if (k === 0) parent = -1;
    else if (topo === 'flat') parent = 0;
    else if (topo === 'chain') parent = k - 1;
    else if (topo === 'bushy') parent = Math.floor(rand() * k); // any earlier node
    else parent = rand() < 0.5 ? 0 : Math.floor(rand() * k); // mixed
    nodes.push({
      parent,
      x: (rand() - 0.5) * 2000,
      y: (rand() - 0.5) * 2000,
      scaleX: 0.25 + rand() * 3,
      scaleY: 0.25 + rand() * 3,
      rotation: (rand() - 0.5) * Math.PI * 4,
      opacity: rand(),
      // Local render bounds for the world-AABB pass — include a non-zero origin
      // sometimes so the bx/by (not just bw/bh) path is exercised.
      bx: rand() < 0.3 ? (rand() - 0.5) * 40 : 0,
      by: rand() < 0.3 ? (rand() - 0.5) * 40 : 0,
      bw: rand() * 300,
      bh: rand() * 200,
    });
  }
  return nodes;
}

/** Two independent stores from the same tree, one composed in JS, one in WASM. */
function pair(nodes: InputNode[]): {
  js: TransformStore;
  wasm: TransformStore;
} {
  return { js: buildStore(nodes), wasm: buildStore(nodes) };
}

function assertBitIdentical(js: TransformStore, wasm: TransformStore): void {
  for (let i = 0; i < js.count; i++) {
    // Object.is semantics via toBe: distinguishes +0/-0 and treats NaN===NaN.
    expect(wasm.wa[i]).toBe(js.wa[i]);
    expect(wasm.wb[i]).toBe(js.wb[i]);
    expect(wasm.wc[i]).toBe(js.wc[i]);
    expect(wasm.wd[i]).toBe(js.wd[i]);
    expect(wasm.we[i]).toBe(js.we[i]);
    expect(wasm.wf[i]).toBe(js.wf[i]);
    expect(wasm.wo[i]).toBe(js.wo[i]);
  }
}

describe.skipIf(!haveWasm)('WASM/JS differential (bit-identical f64)', () => {
  let backend: WasmTransformBackend;

  it('instantiates the module', () => {
    backend = instantiateSync(readFileSync(wasmPath))!;
    expect(backend).not.toBeNull();
    expect(backend.available).toBe(true);
  });

  const topos: Topology[] = ['flat', 'chain', 'bushy', 'mixed'];
  const counts = [1, 2, 3, 5, 8, 17, 64, 100, 1000, 10_000];

  for (const topo of topos) {
    for (const count of counts) {
      it(`${topo} tree, ${count} nodes — SIMD matches JS bit-for-bit`, () => {
        const nodes = randomTree(count, topo, rng(count * 31 + topo.length));
        const { js, wasm } = pair(nodes);
        composeJS(js);
        backend.compose(wasm, 'simd');
        assertBitIdentical(js, wasm);
      });
    }
  }

  it('scalar kernel also matches JS bit-for-bit', () => {
    const nodes = randomTree(500, 'mixed', rng(99));
    const { js, wasm } = pair(nodes);
    composeJS(js);
    backend.compose(wasm, 'scalar');
    assertBitIdentical(js, wasm);
  });

  it('reuses one backend across growing then shrinking scenes', () => {
    for (const count of [10, 5000, 3, 20000, 50]) {
      const nodes = randomTree(count, 'bushy', rng(count + 7));
      const { js, wasm } = pair(nodes);
      composeJS(js);
      backend.compose(wasm, 'simd');
      assertBitIdentical(js, wasm);
    }
  });

  it('resident path (inputView + runKernel + worldView) matches JS bit-for-bit', () => {
    // The designed integration writes inputs straight into wasm memory and reads
    // world matrices straight back out — no per-frame upload/readback copies.
    const nodes = randomTree(2000, 'mixed', rng(4242));
    const js = buildStore(nodes);
    const wasm = buildStore(nodes);
    composeJS(js);

    // Size the store + publish the run table once, then write inputs in place.
    backend.compose(wasm, 'simd');
    backend.uploadRuns(wasm);
    const inV = backend.inputView();
    for (let i = 0; i < wasm.count; i++) {
      inV.x[i] = wasm.x[i];
      inV.y[i] = wasm.y[i];
      inV.sx[i] = wasm.sx[i];
      inV.sy[i] = wasm.sy[i];
      inV.cos[i] = wasm.cos[i];
      inV.sin[i] = wasm.sin[i];
      inV.opacity[i] = wasm.opacity[i];
    }
    backend.runKernel('simd');

    const outV = backend.worldView();
    for (let i = 0; i < js.count; i++) {
      expect(outV.wa[i]).toBe(js.wa[i]);
      expect(outV.wb[i]).toBe(js.wb[i]);
      expect(outV.wc[i]).toBe(js.wc[i]);
      expect(outV.wd[i]).toBe(js.wd[i]);
      expect(outV.we[i]).toBe(js.we[i]);
      expect(outV.wf[i]).toBe(js.wf[i]);
      expect(outV.wo[i]).toBe(js.wo[i]);
    }
  });
});

describe.skipIf(!haveWasm)('WASM/JS world-AABB differential (G1+, bit-identical f64)', () => {
  let backend: WasmTransformBackend;

  const assertAabbsIdentical = (js: TransformStore, wasm: TransformStore) => {
    for (let i = 0; i < js.count; i++) {
      expect(wasm.aminx[i]).toBe(js.aminx[i]);
      expect(wasm.aminy[i]).toBe(js.aminy[i]);
      expect(wasm.amaxx[i]).toBe(js.amaxx[i]);
      expect(wasm.amaxy[i]).toBe(js.amaxy[i]);
    }
  };

  it('instantiates', () => {
    backend = instantiateSync(readFileSync(wasmPath))!;
    expect(backend).not.toBeNull();
  });

  const topos: Topology[] = ['flat', 'chain', 'bushy', 'mixed'];
  for (const topo of topos) {
    for (const count of [1, 2, 3, 8, 64, 1000, 10_000]) {
      it(`${topo} tree, ${count} nodes — compute_aabbs matches JS bit-for-bit`, () => {
        const nodes = randomTree(count, topo, rng(count * 47 + topo.length));
        const { js, wasm } = pair(nodes);
        // AABBs need composed world matrices first.
        composeJS(js);
        computeAabbsJS(js);
        backend.compose(wasm, 'simd');
        backend.computeAabbs(wasm);
        assertAabbsIdentical(js, wasm);
      });
      it(`${topo} tree, ${count} nodes — compute_aabbs_simd matches JS and scalar bit-for-bit`, () => {
        // Lane pairing is legal because js_min/js_max are selection ops over a
        // total order (associative), so the SIMD fold must equal the scalar
        // fold exactly — including odd counts (scalar tail path) and ±0.
        const nodes = randomTree(count, topo, rng(count * 47 + topo.length));
        const { js, wasm } = pair(nodes);
        composeJS(js);
        computeAabbsJS(js);
        backend.compose(wasm, 'simd');

        backend.computeAabbs(wasm, 'simd');
        const n = count;
        const simdMinX = Float64Array.from(wasm.aminx.subarray(0, n));
        const simdMinY = Float64Array.from(wasm.aminy.subarray(0, n));
        const simdMaxX = Float64Array.from(wasm.amaxx.subarray(0, n));
        const simdMaxY = Float64Array.from(wasm.amaxy.subarray(0, n));
        assertAabbsIdentical(js, wasm);

        // Cross-kernel: the scalar kernel over the same inputs must land on
        // the same bits (Object.is semantics via toBe: ±0 and NaN included).
        backend.computeAabbs(wasm, 'scalar');
        for (let i = 0; i < n; i++) {
          expect(wasm.aminx[i]).toBe(simdMinX[i]);
          expect(wasm.aminy[i]).toBe(simdMinY[i]);
          expect(wasm.amaxx[i]).toBe(simdMaxX[i]);
          expect(wasm.amaxy[i]).toBe(simdMaxY[i]);
        }
      });
    }
  }

  it('resident path (boundsView + runAabbs + aabbView) matches JS bit-for-bit', () => {
    const nodes = randomTree(2000, 'mixed', rng(0xaab));
    const js = buildStore(nodes);
    const wasm = buildStore(nodes);
    composeJS(js);
    computeAabbsJS(js);

    // Size + compose once, publish runs, write inputs + bounds in place, run.
    backend.compose(wasm, 'simd');
    backend.uploadRuns(wasm);
    const inV = backend.inputView();
    const bV = backend.boundsView();
    for (let i = 0; i < wasm.count; i++) {
      inV.x[i] = wasm.x[i];
      inV.y[i] = wasm.y[i];
      inV.sx[i] = wasm.sx[i];
      inV.sy[i] = wasm.sy[i];
      inV.cos[i] = wasm.cos[i];
      inV.sin[i] = wasm.sin[i];
      inV.opacity[i] = wasm.opacity[i];
      bV.bx[i] = wasm.bx[i];
      bV.by[i] = wasm.by[i];
      bV.bw[i] = wasm.bw[i];
      bV.bh[i] = wasm.bh[i];
    }
    backend.runKernel('simd');
    backend.runAabbs(wasm.count);

    const aV = backend.aabbView();
    for (let i = 0; i < js.count; i++) {
      expect(aV.aminx[i]).toBe(js.aminx[i]);
      expect(aV.aminy[i]).toBe(js.aminy[i]);
      expect(aV.amaxx[i]).toBe(js.amaxx[i]);
      expect(aV.amaxy[i]).toBe(js.amaxy[i]);
    }
  });

  it('AABB matches Entity.getWorldBounds semantics for a known transform', () => {
    // Root(identity) → one child rotated 90° with a 100×40 box at origin.
    const nodes: InputNode[] = [
      {
        parent: -1,
        x: 0,
        y: 0,
        scaleX: 1,
        scaleY: 1,
        rotation: 0,
        opacity: 1,
        bw: 0,
        bh: 0,
      },
      {
        parent: 0,
        x: 10,
        y: 20,
        scaleX: 1,
        scaleY: 1,
        rotation: Math.PI / 2,
        opacity: 1,
        bx: 0,
        by: 0,
        bw: 100,
        bh: 40,
      },
    ];
    const js = buildStore(nodes);
    composeJS(js);
    computeAabbsJS(js);
    const childStore = js.storeIndexOf[1];
    // 90° rot of a 100×40 box at (10,20): corners (10,20),(10,120),(-30,20),
    // (-30,120) → x∈[-30,10], y∈[20,120].
    expect(js.aminx[childStore]).toBeCloseTo(-30, 9);
    expect(js.amaxx[childStore]).toBeCloseTo(10, 9);
    expect(js.aminy[childStore]).toBeCloseTo(20, 9);
    expect(js.amaxy[childStore]).toBeCloseTo(120, 9);
  });
});

// A guard so a machine WITHOUT the asset still reports why nothing ran, rather
// than silently passing an empty suite.
describe('WASM asset presence', () => {
  it(haveWasm ? 'asset present' : 'asset absent (differential suite skipped)', () => {
    expect(typeof haveWasm).toBe('boolean');
  });
});
