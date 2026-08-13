// Linear-memory leak on capacity growth (#491).
//
// `backend.ts::ensure` re-inits the transform store IN PLACE on every growth —
// there is no re-instantiation — and the anim/hit/particle backends re-init in
// place too. The crate's `*_init` exports used to leak their previous SoA
// allocation (21 f64 arrays for the transform store, 13/8/7 for anim/hit/
// particle) with no `dealloc` anywhere, so dlmalloc never saw the old pointers
// and wasm memory grew monotonically with each re-init.
//
// These tests call the raw ABI directly and assert `memory.buffer.byteLength`
// stays flat across repeated same-capacity inits and grows only once for a real
// growth. Pre-fix, every repeated init leaked and (with growth) enlarged memory.
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const wasmPath = resolve(process.cwd(), 'src/wasm/vectojs_core.wasm');
const haveWasm = existsSync(wasmPath);

interface RawExports {
  memory: WebAssembly.Memory;
  init(capacity: number, maxRuns: number): number;
  anim_init(springCap: number, tweenCap: number): number;
  hit_init(entityCap: number, cellCap: number, itemCap: number): number;
  particle_init(capacity: number): number;
}

function load(): RawExports {
  const bytes = readFileSync(wasmPath);
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const module = new WebAssembly.Module(copy);
  return new WebAssembly.Instance(module, {}).exports as unknown as RawExports;
}

const bytes = (ex: RawExports): number => ex.memory.buffer.byteLength;

describe.skipIf(!haveWasm)('SoA re-init frees the previous allocation', () => {
  it('repeated same-capacity transform init does not grow linear memory', () => {
    const ex = load();
    const cap = 1e5;
    ex.init(cap, 16);
    const first = bytes(ex);
    for (let i = 0; i < 9; i++) ex.init(cap, 16);
    // Pre-fix each init leaked 21 × (cap + 8) × 8 B and grew the memory.
    expect(bytes(ex)).toBe(first);
  });

  it('transform growth grows once, then the larger capacity is stable', () => {
    const ex = load();
    ex.init(1e4, 16);
    const small = bytes(ex);
    ex.init(1e5, 16);
    const grown = bytes(ex);
    expect(grown).toBeGreaterThan(small);
    for (let i = 0; i < 4; i++) ex.init(1e5, 16);
    expect(bytes(ex)).toBe(grown);
  });

  it('anim/hit/particle init free their previous SoA on re-init', () => {
    const ex = load();
    ex.anim_init(1e5, 1e5);
    const a1 = bytes(ex);
    ex.anim_init(1e5, 1e5);
    expect(bytes(ex)).toBe(a1);

    ex.hit_init(1e5, 1e4, 4e5);
    const h1 = bytes(ex);
    ex.hit_init(1e5, 1e4, 4e5);
    expect(bytes(ex)).toBe(h1);

    ex.particle_init(1e5);
    const p1 = bytes(ex);
    ex.particle_init(1e5);
    expect(bytes(ex)).toBe(p1);
  });
});
