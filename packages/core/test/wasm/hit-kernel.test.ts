// @vitest-environment node
// G3 spike — correctness of the hit-test broad-phase BEFORE trusting any bench.
// The WASM grid query must return the SAME topmost AABB-containing entity as a
// brute-force O(N) scan (the "highest index whose AABB contains the point"),
// which is the broad-phase the current findHitRecursively walk approximates.
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { WASM_STATUS } from '../../src/wasm/backend';

const wasmPath = resolve(process.cwd(), 'src/wasm/vectojs_core.wasm');
const haveWasm = existsSync(wasmPath);

interface HitExports {
  memory: WebAssembly.Memory;
  hit_init(entityCap: number, cellCap: number, itemCap: number): number;
  hit_build(count: number, vw: number, vh: number, cellSize: number): number;
  hit_query(px: number, py: number): number;
  hit_overflow(): number;
  p_h_minx(): number;
  p_h_miny(): number;
  p_h_maxx(): number;
  p_h_maxy(): number;
}

/** Load a raw instance with NO `hit_init`, for call-order tests. */
function loadRaw(): HitExports {
  const module = new WebAssembly.Module(readFileSync(wasmPath));
  return new WebAssembly.Instance(module, {}).exports as unknown as HitExports;
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

  // Regression coverage for the security review on the initial G3 spike: a raw
  // pointer kernel over wasm linear memory must stay memory-safe even when a
  // caller passes a bogus `count`, or when the grid genuinely overflows its
  // item capacity — neither should ever read outside the allocated buffers.
  it('clamps an over-large count to the allocated capacity instead of reading OOB', () => {
    const VW = 400;
    const VH = 300;
    const CS = 64;
    const gw = Math.ceil(VW / CS);
    const gh = Math.ceil(VH / CS);
    const ENTITY_CAP = 4;
    const { ex, minx, miny, maxx, maxy } = instantiate(ENTITY_CAP, gw * gh, 64);

    for (let i = 0; i < ENTITY_CAP; i++) {
      minx[i] = 50 + i * 10;
      miny[i] = 50;
      maxx[i] = minx[i] + 8;
      maxy[i] = 58;
    }
    // A count far beyond what hit_init allocated. Before the fix this walked
    // cell_range's reads past the minx/miny/maxx/maxy buffers (into whatever
    // the next leaked array happens to be in linear memory); now hit_build
    // clamps it internally, so the call must not throw/trap and results must
    // stay confined to real, allocated entities.
    expect(() => ex.hit_build(1_000_000, VW, VH, CS)).not.toThrow();
    const got = ex.hit_query(54, 54);
    expect(got).toBeGreaterThanOrEqual(-1);
    expect(got).toBeLessThan(ENTITY_CAP);
  });

  it('keeps every hit_query result in-bounds under item_cap overflow (no OOB read, no crash)', () => {
    const VW = 640;
    const VH = 640;
    const CS = 32;
    const gw = Math.ceil(VW / CS);
    const gh = Math.ceil(VH / CS);
    const ENTITY_CAP = 5;
    // item_cap sized to overflow entity 0 (which spans the whole viewport).
    // Note: item_cap is a single flat budget shared across ALL cells (a cell's
    // write offset is its position in one global counting-sort layout), so an
    // overflowing entity can legitimately crowd out registrations for OTHER
    // cells too — that is a resource/QoS tradeoff (an entity may not register
    // in the grid and its cell then reports fewer/no hits), not a safety bug.
    // The property this test protects is the one the security review flagged:
    // no result may ever read outside the allocated buffers.
    const { ex, minx, miny, maxx, maxy } = instantiate(ENTITY_CAP, gw * gh, 4);

    minx[0] = 0;
    miny[0] = 0;
    maxx[0] = VW;
    maxy[0] = VH; // spans every cell — will overflow the tiny item_cap
    minx[1] = 300;
    miny[1] = 300;
    maxx[1] = 320;
    maxy[1] = 320;

    ex.hit_build(2, VW, VH, CS);
    expect(ex.hit_overflow()).toBe(1);

    // Before the fix, cell_count was never reconciled to what Pass 2 actually
    // wrote, so a query could read stale/garbage `idx` values out of `items`
    // (or past `items` entirely) and then index the AABB arrays with them.
    // Every result must now be -1 or a valid, in-bounds entity index.
    const rand = ((seed: number) => {
      let s = seed >>> 0;
      return () => ((s = (s * 1664525 + 1013904223) >>> 0), s / 0x100000000);
    })(0x5eed);
    for (let t = 0; t < 500; t++) {
      const got = ex.hit_query(rand() * VW, rand() * VH);
      expect(got).toBeGreaterThanOrEqual(-1);
      expect(got).toBeLessThan(ENTITY_CAP);
    }
  });

  it('rejects build and query before hit_init instead of trapping', () => {
    // A call-order mistake used to dereference null grid pointers: a trap that
    // aborts the whole shared wasm instance — every backend of the Scene dies
    // with it. Both exports must now reject with a status instead.
    const ex = loadRaw();
    expect(ex.hit_build(4, 400, 300, 64)).toBe(WASM_STATUS.UNINITIALIZED);
    expect(ex.hit_query(10, 10)).toBe(-WASM_STATUS.UNINITIALIZED);
  });

  it('rejects an entity cap whose +8 pad overflows, leaving the old grid live', () => {
    const VW = 400;
    const VH = 300;
    const CS = 64;
    const gw = Math.ceil(VW / CS);
    const gh = Math.ceil(VH / CS);
    const { ex, minx, miny, maxx, maxy } = instantiate(8, gw * gh, 128);

    minx[0] = 50;
    miny[0] = 50;
    maxx[0] = 60;
    maxy[0] = 60;
    ex.hit_build(1, VW, VH, CS);
    expect(ex.hit_query(55, 55)).toBe(0);

    // capacity + 8 wraps on wasm32 usize for this count; the init must reject
    // rather than allocate a 4-slot array and let hit_build overrun it.
    expect(ex.hit_init(2 ** 32 - 4, gw * gh, 128)).toBe(WASM_STATUS.OVERFLOW);

    // The previous grid is untouched by a rejected init.
    expect(ex.hit_query(55, 55)).toBe(0);
  });

  it('huge-grid queries stay defined where the i32 cell index would wrap (#648)', () => {
    // cell_size=1e-4 over an 800x600 viewport gives grid_w=8e6,
    // grid_h=6e6 — gw*gh = 4.8e13, far past i32::MAX. The build path
    // computes its cell indices in i64 and clamps the materialized cells
    // to cell_cap; the query path must use the same i64 math so a point
    // whose true index exceeds 2^32 yields a defined miss instead of a
    // wrapped index that can read an unrelated (populated) cell.
    const VW = 800;
    const VH = 600;
    const CS = 1e-4;
    const GW = Math.ceil(VW / CS); // 8_000_000
    const GH = Math.ceil(VH / CS); // 6_000_000
    expect(GW * GH).toBeGreaterThan(2 ** 31);
    // Materialized cells clamp to cell_cap: row 0, columns 0..CELL_CAP-1,
    // i.e. the region x < CELL_CAP*CS, y < CS.
    const CELL_CAP = 4096;
    const { ex, minx, miny, maxx, maxy } = instantiate(48, CELL_CAP, 16384);

    const rand = rng(0x648);
    const N = 48;
    for (let i = 0; i < N; i++) {
      const w = 0.01 + rand() * 0.01; // ~100-200 columns wide
      const x = rand() * (CELL_CAP * CS - 0.03);
      minx[i] = x;
      maxx[i] = x + w;
      miny[i] = 0;
      maxy[i] = 9e-5; // stays inside row 0 so every membership fits cell_cap
    }
    ex.hit_build(N, VW, VH, CS);
    expect(ex.hit_overflow()).toBe(0);

    // 1) Across the whole viewport the query agrees with brute force:
    // exact topmost match inside the populated band, defined -1 elsewhere.
    for (let t = 0; t < 2000; t++) {
      const px = rand() * VW;
      const py = rand() * VH;
      expect(ex.hit_query(px, py)).toBe(brute(minx, miny, maxx, maxy, N, px, py));
    }

    // 2) Wrap-zone probes: points whose true cell index exceeds 2^32 and
    // whose i32-wrapped index lands exactly on a POPULATED cell (wrap
    // target CELL_CAP-1). These must return a defined miss, never a hit
    // dredged from the wrong cell's item list.
    let probes = 0;
    for (let cy = 600; cy < GH && probes < 50; cy += 7) {
      const r = (cy * GW) % 2 ** 32; // exact: cy*GW < 4.8e12 < 2^53
      if (r >= CELL_CAP) continue;
      const cx = CELL_CAP - 1 - r; // (cy*GW + cx) mod 2^32 == CELL_CAP-1
      const px = (cx + 0.5) * CS;
      const py = (cy + 0.5) * CS; // py >= 0.06 — outside every box (y < 9e-5)
      expect(cx).toBeLessThan(GW);
      expect(ex.hit_query(px, py)).toBe(-1);
      expect(ex.hit_query(px, py)).toBe(brute(minx, miny, maxx, maxy, N, px, py));
      probes++;
    }
    expect(probes).toBeGreaterThan(0);

    // 3) Deep wrap-zone sanity: generic far-field points also stay defined.
    for (let t = 0; t < 200; t++) {
      const px = rand() * VW;
      const py = VH * (0.5 + rand() * 0.5); // lower half: true index > 2^31
      const got = ex.hit_query(px, py);
      expect(got).toBe(brute(minx, miny, maxx, maxy, N, px, py));
    }
  });
});
