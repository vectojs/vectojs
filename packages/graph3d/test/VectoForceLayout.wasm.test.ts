import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { VectoForceLayout } from '../src/layout/VectoForceLayout';
import type { GraphData } from '../src/types';
import { instantiateSync } from '../src/wasm/force-backend';

// Built by crates/vectojs-force-rs/build.sh, gitignored (built in CI). Skipped
// (not failed) when absent — the JS Barnes-Hut is the permanent fallback.
const wasmPath = fileURLToPath(new URL('../src/wasm/vectojs_force.wasm', import.meta.url));
const haveWasm = existsSync(wasmPath);

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomGraph(n: number, links: number, seed: number): GraphData {
  const rand = mulberry32(seed);
  const nodes = Array.from({ length: n }, (_, id) => ({
    id,
    x: (rand() - 0.5) * 1000,
    y: (rand() - 0.5) * 1000,
    z: (rand() - 0.5) * 1000,
  }));
  const edges: GraphData['links'] = [];
  for (let i = 1; i < n; i++) edges.push({ source: i, target: Math.floor(rand() * i) });
  for (let i = 0; i < links; i++) {
    const s = Math.floor(rand() * n);
    const t = Math.floor(rand() * n);
    if (s !== t) edges.push({ source: s, target: t });
  }
  return { nodes, links: edges };
}

/** A graph with exactly-coincident points, to exercise the deterministic jitter
 *  path (both the JS and the Rust kernel must jitter bit-identically). */
function coincidentGraph(): GraphData {
  const nodes = [
    { id: 0, x: 0, y: 0, z: 0 },
    { id: 1, x: 0, y: 0, z: 0 },
    { id: 2, x: 0, y: 0, z: 0 },
    { id: 3, x: 100, y: 0, z: 0 },
    { id: 4, x: 100, y: 0, z: 0 },
    { id: 5, x: -100, y: 50, z: 20 },
    { id: 6, x: 50, y: -50, z: -30 },
  ];
  return { nodes, links: [] };
}

/** Bit-compare two position buffers (Object.is, distinguishing +0/-0 and NaN).
 *  Returns a describing string on first mismatch, or null when identical. */
function firstMismatch(a: Float32Array, b: Float32Array): string | null {
  for (let i = 0; i < a.length; i++) {
    if (!Object.is(a[i], b[i])) {
      return `positions[${i}]: js=${a[i]} wasm=${b[i]}`;
    }
  }
  return null;
}

function assertIdentical(js: VectoForceLayout, wasm: VectoForceLayout, ticks: number): void {
  for (let i = 0; i < ticks; i++) {
    js.step();
    wasm.step();
  }
  const mismatch = firstMismatch(js.positions, wasm.positions);
  expect(mismatch).toBeNull();
}

describe.skipIf(!haveWasm)('VectoForceLayout — WASM force-kernel differential', () => {
  it('produces bit-identical positions to the JS tick on a random graph', async () => {
    const data = randomGraph(200, 400, 1234);
    const js = new VectoForceLayout({ seed: 7 });
    const wasm = new VectoForceLayout({ seed: 7 });
    js.setGraph(data);
    wasm.setGraph(data);
    const backend = instantiateSync(readFileSync(wasmPath));
    expect(backend).not.toBeNull();
    expect(await wasm.enableWasmForce(readFileSync(wasmPath))).toBe(true);
    assertIdentical(js, wasm, 300);
    js.dispose();
    wasm.dispose();
  });

  it('stays bit-identical through the coincident-point jitter path', async () => {
    const data = coincidentGraph();
    const js = new VectoForceLayout({ seed: 3 });
    const wasm = new VectoForceLayout({ seed: 3 });
    js.setGraph(data);
    wasm.setGraph(data);
    expect(await wasm.enableWasmForce(readFileSync(wasmPath))).toBe(true);
    assertIdentical(js, wasm, 200);
    js.dispose();
    wasm.dispose();
  });

  it('falls back to the JS tick when the module cannot instantiate', async () => {
    const data = randomGraph(20, 20, 99);
    const layout = new VectoForceLayout({ seed: 1 });
    layout.setGraph(data);
    // Corrupt bytes must be rejected and leave the JS path active.
    const enabled = await layout.enableWasmForce(new Uint8Array([1, 2, 3, 4]));
    expect(enabled).toBe(false);
    // The JS path still steps and settles normally.
    expect(layout.step()).toBe(true);
    layout.step(2000);
    expect(layout.step()).toBe(false);
    layout.dispose();
  });
});

describe('VectoForceLayout — WASM API without a built artifact', () => {
  it('enableWasmForce returns false and keeps the JS path when the binary is absent', async () => {
    const layout = new VectoForceLayout();
    layout.setGraph({ nodes: [{ id: 'a' }, { id: 'b' }], links: [{ source: 'a', target: 'b' }] });
    // A non-existent URL fails to fetch and must fall back silently.
    const enabled = await layout.enableWasmForce('file:///nonexistent/vectojs_force.wasm');
    expect(enabled).toBe(false);
    expect(layout.step()).toBe(true);
    layout.dispose();
  });
});
