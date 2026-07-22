// @vitest-environment node
// G3 spike — correctness of the hit-test broad-phase BEFORE trusting any bench.
// The WASM grid query must return the SAME topmost AABB-containing entity as a
// brute-force O(N) scan (the "highest index whose AABB contains the point"),
// which is the broad-phase the current findHitRecursively walk approximates.
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const wasmPath = resolve(process.cwd(), 'src/wasm/vectojs_core.wasm');
const haveWasm = existsSync(wasmPath);

interface HitExports {
  memory: WebAssembly.Memory;
  hit_init(entityCap: number, cellCap: number, itemCap: number): void;
  hit_build(count: number, vw: number, vh: number, cellSize: number): void;
  hit_query(px: number, py: number): number;
  hit_overflow(): number;
  p_h_minx(): number;
  p_h_miny(): number;
  p_h_maxx(): number;
  p_h_maxy(): number;
}

function instantiate(entityCap: number, cellCap: number, itemCap: number) {
  const module = new WebAssembly.Module(readFileSync(wasmPath));
  const instance = new WebAssembly.Instance(module, {});
  const ex = instance.exports as unknown as HitExports;
  ex.hit_init(entityCap, cellCap, itemCap);
  const n = entityCap + 8;
  const f64 = (p: number): Float64Array => new Float64Array(ex.memory.buffer, p, n);
  return {
    ex,
    minx: f64(ex.p_h_minx()),
    miny: f64(ex.p_h_miny()),
    maxx: f64(ex.p_h_maxx()),
    maxy: f64(ex.p_h_maxy()),
  };
}

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0), s / 0x100000000);
}

// Brute-force reference: topmost (max index) AABB containing (px, py), or -1.
function brute(
  minx: Float64Array,
  miny: Float64Array,
  maxx: Float64Array,
  maxy: Float64Array,
  count: number,
  px: number,
  py: number,
): number {
  let best = -1;
  for (let i = 0; i < count; i++) {
    if (px >= minx[i] && px <= maxx[i] && py >= miny[i] && py <= maxy[i] && i > best) best = i;
  }
  return best;
}

describe.skipIf(!haveWasm)('G3 spike — hit-test broad-phase', () => {
  it('grid query matches brute-force topmost over random scenes and points', () => {
    const N = 2000;
    const VW = 1280;
    const VH = 800;
    const CS = 64;
    const gw = Math.ceil(VW / CS);
    const gh = Math.ceil(VH / CS);
    // Each entity spans at most ~2 cells; give generous item capacity.
    const { ex, minx, miny, maxx, maxy } = instantiate(N, gw * gh, N * 16);

    const rand = rng(0xbeef);
    for (let i = 0; i < N; i++) {
      const w = 8 + rand() * 60;
      const h = 8 + rand() * 60;
      const x = rand() * (VW + 200) - 100; // some spill outside the viewport
      const y = rand() * (VH + 200) - 100;
      minx[i] = x;
      miny[i] = y;
      maxx[i] = x + w;
      maxy[i] = y + h;
    }
    ex.hit_build(N, VW, VH, CS);
    expect(ex.hit_overflow()).toBe(0);

    const q = rng(0x77);
    for (let t = 0; t < 3000; t++) {
      const px = q() * VW;
      const py = q() * VH;
      const got = ex.hit_query(px, py);
      const want = brute(minx, miny, maxx, maxy, N, px, py);
      expect(got).toBe(want);
    }
  });

  it('returns -1 for an empty region and handles overlapping stacks (topmost wins)', () => {
    const VW = 400;
    const VH = 300;
    const CS = 64;
    const gw = Math.ceil(VW / CS);
    const gh = Math.ceil(VH / CS);
    const { ex, minx, miny, maxx, maxy } = instantiate(8, gw * gh, 128);

    // Three overlapping boxes around (100,100); index 2 is topmost.
    for (let i = 0; i < 3; i++) {
      minx[i] = 80;
      miny[i] = 80;
      maxx[i] = 140;
      maxy[i] = 140;
    }
    // A separate box far away.
    minx[3] = 300;
    miny[3] = 200;
    maxx[3] = 360;
    maxy[3] = 260;
    ex.hit_build(4, VW, VH, CS);

    expect(ex.hit_query(100, 100)).toBe(2); // topmost of the stack
    expect(ex.hit_query(330, 230)).toBe(3); // the lone far box
    expect(ex.hit_query(10, 10)).toBe(-1); // empty
    expect(ex.hit_query(-5, 100)).toBe(-1); // outside viewport
  });

  it('flags overflow when item capacity is too small', () => {
    const VW = 640;
    const VH = 640;
    const CS = 32; // small cells → a big box spans many cells
    const gw = Math.ceil(VW / CS);
    const gh = Math.ceil(VH / CS);
    const { ex, minx, miny, maxx, maxy } = instantiate(4, gw * gh, 4); // tiny item cap

    // One entity covering the whole viewport → spans gw*gh cells >> item cap.
    minx[0] = 0;
    miny[0] = 0;
    maxx[0] = VW;
    maxy[0] = VH;
    ex.hit_build(1, VW, VH, CS);
    expect(ex.hit_overflow()).toBe(1);
  });
});
