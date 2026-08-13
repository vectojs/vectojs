// WASM ABI bounds validation.
//
// The crate's exports take raw counts and dereference raw pointers, and their
// Safety contracts used to be enforced only by the TypeScript calling
// convention. PR #136's own review found two out-of-bounds read paths that way.
// The sandbox stops such a bug corrupting the browser, but it can still trap,
// corrupt this module's own linear memory, or silently return wrong geometry and
// break a frame.
//
// These tests call the raw ABI directly with arguments a bug (or a corrupted run
// table) could produce, and assert the call is REJECTED and writes nothing —
// rather than reading past its allocation.
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { WASM_STATUS } from '../../src/wasm/backend';

const wasmPath = resolve(process.cwd(), 'src/wasm/vectojs_core.wasm');
const haveWasm = existsSync(wasmPath);

interface RawExports {
  memory: WebAssembly.Memory;
  init(capacity: number, maxRuns: number): number;
  set_run_count(n: number): number;
  compose_simd(): number;
  compose_scalar(): number;
  compute_aabbs(count: number): number;
  p_run_parent(): number;
  p_run_start(): number;
  p_run_len(): number;
  p_wa(): number;
  p_x(): number;
  anim_init(springCap: number, tweenCap: number): number;
  spring_step(dt: number, count: number): number;
  tween_step(dt: number, count: number): number;
  p_s_val(): number;
  p_s_vel(): number;
  p_s_target(): number;
  p_s_stiff(): number;
  p_s_damp(): number;
  p_s_mass(): number;
  p_t_elapsed(): number;
  p_t_val(): number;
  particle_init(capacity: number): number;
  particle_step(
    dt: number,
    mouseX: number,
    mouseY: number,
    width: number,
    height: number,
    springK: number,
    damping: number,
    bounceDamping: number,
    maxVelocity: number,
    explActive: number,
    explX: number,
    explY: number,
    explForce: number,
    count: number,
  ): number;
  pp_px(): number;
  pp_life(): number;
}

/** `particle_step` with benign physics, so only `count` is under test. */
function particleStep(ex: RawExports, count: number): number {
  return ex.particle_step(0.016, -99999, -99999, 800, 600, 0.1, 0.9, 0.5, 500, 0, 0, 0, 0, count);
}

function load(): RawExports {
  const bytes = readFileSync(wasmPath);
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const module = new WebAssembly.Module(copy);
  return new WebAssembly.Instance(module, {}).exports as unknown as RawExports;
}

/** Write one sibling run into the run table. */
function writeRun(ex: RawExports, index: number, parent: number, start: number, len: number): void {
  const buf = ex.memory.buffer;
  new Int32Array(buf, ex.p_run_parent(), index + 1)[index] = parent;
  new Int32Array(buf, ex.p_run_start(), index + 1)[index] = start;
  new Int32Array(buf, ex.p_run_len(), index + 1)[index] = len;
}

describe.skipIf(!haveWasm)('WASM ABI bounds validation', () => {
  it('rejects a kernel that runs before init', () => {
    const ex = load();
    // No init: the store pointers are still null, so composing would dereference
    // them. This used to be undefined behaviour reachable from one missing call.
    expect(ex.compose_scalar()).toBe(WASM_STATUS.UNINITIALIZED);
    expect(ex.compose_simd()).toBe(WASM_STATUS.UNINITIALIZED);
    expect(ex.compute_aabbs(4)).toBe(WASM_STATUS.UNINITIALIZED);
    expect(ex.set_run_count(1)).toBe(WASM_STATUS.UNINITIALIZED);
  });

  it('rejects a run count beyond the allocated run table', () => {
    const ex = load();
    ex.init(64, 8);
    expect(ex.set_run_count(8)).toBe(WASM_STATUS.OK);
    expect(ex.set_run_count(9)).toBe(WASM_STATUS.CAPACITY);
    // Rejected calls must leave run_count unchanged, or a later kernel would
    // still walk past the table.
    expect(ex.set_run_count(0)).toBe(WASM_STATUS.OK);
  });

  it('rejects an AABB count beyond the entity capacity', () => {
    const ex = load();
    ex.init(32, 4);
    expect(ex.compute_aabbs(32)).toBe(WASM_STATUS.OK);
    expect(ex.compute_aabbs(33)).toBe(WASM_STATUS.CAPACITY);
    expect(ex.compute_aabbs(1 << 24)).toBe(WASM_STATUS.CAPACITY);
  });

  it('rejects a run whose slots extend past capacity', () => {
    const ex = load();
    ex.init(16, 4);
    // start + len = 20 > capacity 16: the composition loop would write four
    // slots past the allocation.
    writeRun(ex, 0, 0, 8, 12);
    expect(ex.set_run_count(1)).toBe(WASM_STATUS.OK);
    expect(ex.compose_scalar()).toBe(WASM_STATUS.BAD_RUN);
    expect(ex.compose_simd()).toBe(WASM_STATUS.BAD_RUN);
  });

  it('rejects a run naming a parent outside the store', () => {
    const ex = load();
    ex.init(16, 4);
    // The parent index is dereferenced to read the parent world matrix.
    writeRun(ex, 0, 999, 1, 2);
    expect(ex.set_run_count(1)).toBe(WASM_STATUS.OK);
    expect(ex.compose_scalar()).toBe(WASM_STATUS.BAD_RUN);
  });

  it('rejects negative run fields', () => {
    const ex = load();
    ex.init(16, 4);
    // i32 tables: a negative value cast to usize becomes enormous, which is the
    // classic way a sign bug turns into an out-of-bounds walk.
    writeRun(ex, 0, 0, -1, 2);
    expect(ex.set_run_count(1)).toBe(WASM_STATUS.OK);
    expect(ex.compose_scalar()).toBe(WASM_STATUS.BAD_RUN);

    writeRun(ex, 0, 0, 1, -4);
    expect(ex.compose_scalar()).toBe(WASM_STATUS.BAD_RUN);

    writeRun(ex, 0, -2, 1, 2);
    expect(ex.compose_scalar()).toBe(WASM_STATUS.BAD_RUN);
  });

  it('rejects a run whose start + len overflows', () => {
    const ex = load();
    ex.init(16, 4);
    // Checked arithmetic matters: a naive `start + len <= capacity` wraps and
    // passes for values near usize::MAX. i32 max is the largest we can express
    // through the table.
    writeRun(ex, 0, 0, 0x7fffffff, 0x7fffffff);
    expect(ex.set_run_count(1)).toBe(WASM_STATUS.OK);
    expect(ex.compose_scalar()).toBe(WASM_STATUS.BAD_RUN);
  });

  it('a rejected kernel leaves the output store untouched', () => {
    const ex = load();
    ex.init(16, 4);

    // Establish a known-good frame first.
    writeRun(ex, 0, 0, 1, 2);
    expect(ex.set_run_count(1)).toBe(WASM_STATUS.OK);
    expect(ex.compose_scalar()).toBe(WASM_STATUS.OK);

    const wa = new Float64Array(ex.memory.buffer, ex.p_wa(), 16);
    const before = Array.from(wa);

    // Now corrupt the table and re-run: the kernel must decline rather than
    // partially overwrite the previous frame's matrices.
    writeRun(ex, 0, 0, 4, 99);
    expect(ex.compose_scalar()).toBe(WASM_STATUS.BAD_RUN);
    expect(Array.from(wa)).toEqual(before);
  });

  it('still composes correctly once the run table is valid', () => {
    const ex = load();
    ex.init(8, 2);

    const x = new Float64Array(ex.memory.buffer, ex.p_x(), 8);
    // Slot 0 is the root (seeded to identity); slot 1 is its child at x = 5.
    x[1] = 5;
    writeRun(ex, 0, 0, 1, 1);
    expect(ex.set_run_count(1)).toBe(WASM_STATUS.OK);
    expect(ex.compose_scalar()).toBe(WASM_STATUS.OK);
    // The guards must not have changed the arithmetic — only whether it runs.
    expect(ex.compute_aabbs(2)).toBe(WASM_STATUS.OK);
  });
});

// The anim and particle kernels are separate SoA modules with their own statics.
// Neither recorded a capacity at all before this: `anim.rs` had no capacity field
// and `particle_init` took a `capacity` argument it immediately discarded, so
// their Safety contracts were unenforceable even in principle — there was nothing
// to compare a count against.
describe.skipIf(!haveWasm)('anim ABI bounds validation', () => {
  it('rejects a step before anim_init', () => {
    const ex = load();
    expect(ex.spring_step(0.016, 4)).toBe(WASM_STATUS.UNINITIALIZED);
    expect(ex.tween_step(16, 4)).toBe(WASM_STATUS.UNINITIALIZED);
  });

  it('rejects a count beyond the allocated spring/tween capacity', () => {
    const ex = load();
    ex.anim_init(16, 8);
    expect(ex.spring_step(0.016, 16)).toBe(WASM_STATUS.OK);
    expect(ex.spring_step(0.016, 17)).toBe(WASM_STATUS.CAPACITY);
    expect(ex.tween_step(16, 8)).toBe(WASM_STATUS.OK);
    expect(ex.tween_step(16, 9)).toBe(WASM_STATUS.CAPACITY);
  });

  it('validates the two capacities independently', () => {
    const ex = load();
    // Asymmetric allocation: a shared bound would let the smaller array be
    // walked past by a count that is legal for the larger one.
    ex.anim_init(64, 4);
    expect(ex.spring_step(0.016, 64)).toBe(WASM_STATUS.OK);
    expect(ex.tween_step(16, 64)).toBe(WASM_STATUS.CAPACITY);
    expect(ex.tween_step(16, 4)).toBe(WASM_STATUS.OK);
  });

  it('rejects a count that would run far off the end', () => {
    const ex = load();
    ex.anim_init(8, 8);
    expect(ex.spring_step(0.016, 1 << 24)).toBe(WASM_STATUS.CAPACITY);
    expect(ex.tween_step(16, 1 << 24)).toBe(WASM_STATUS.CAPACITY);
  });

  it('a rejected spring step leaves the SoA untouched', () => {
    const ex = load();
    ex.anim_init(8, 8);
    const val = new Float64Array(ex.memory.buffer, ex.p_s_val(), 16);
    const vel = new Float64Array(ex.memory.buffer, ex.p_s_vel(), 16);
    // A spring displaced from its target would move if the kernel ran.
    val.fill(5);
    vel.fill(1);
    const beforeVal = Array.from(val);
    const beforeVel = Array.from(vel);
    expect(ex.spring_step(0.016, 9)).toBe(WASM_STATUS.CAPACITY);
    expect(Array.from(val)).toEqual(beforeVal);
    expect(Array.from(vel)).toEqual(beforeVel);
  });

  it('a rejected tween step does not advance elapsed', () => {
    const ex = load();
    ex.anim_init(8, 8);
    const elapsed = new Float64Array(ex.memory.buffer, ex.p_t_elapsed(), 16);
    const out = new Float64Array(ex.memory.buffer, ex.p_t_val(), 16);
    const before = Array.from(elapsed);
    expect(ex.tween_step(16, 9)).toBe(WASM_STATUS.CAPACITY);
    // `elapsed` is kernel-side STATE, so a partial advance would corrupt every
    // later frame rather than just this one.
    expect(Array.from(elapsed)).toEqual(before);
    expect(Array.from(out)).toEqual(Array.from({ length: 16 }, () => 0));
  });

  it('still steps correctly once the counts are valid', () => {
    const ex = load();
    ex.anim_init(4, 4);
    const buf = ex.memory.buffer;
    const val = new Float64Array(buf, ex.p_s_val(), 12);
    const vel = new Float64Array(buf, ex.p_s_vel(), 12);
    const target = new Float64Array(buf, ex.p_s_target(), 12);
    const stiff = new Float64Array(buf, ex.p_s_stiff(), 12);
    const damp = new Float64Array(buf, ex.p_s_damp(), 12);
    const mass = new Float64Array(buf, ex.p_s_mass(), 12);
    val[0] = 100;
    vel[0] = 0;
    target[0] = 0;
    // Real physics: the arrays are zero-filled, and mass = 0 would make
    // acceleration 0/0 = NaN rather than exercising the kernel.
    stiff[0] = 170;
    damp[0] = 26;
    mass[0] = 1;
    // The spring must accelerate toward its target. The guards gate execution
    // only — they must never alter the arithmetic.
    expect(ex.spring_step(0.016, 4)).toBe(WASM_STATUS.OK);
    expect(val[0]).toBeLessThan(100);
    expect(Number.isNaN(val[0])).toBe(false);
  });
});

describe.skipIf(!haveWasm)('particle ABI bounds validation', () => {
  it('rejects a step before particle_init', () => {
    const ex = load();
    // Negated status: 0 and 1 are both valid success returns (the fused pending
    // flag), so a rejection cannot share their encoding.
    expect(particleStep(ex, 4)).toBe(-WASM_STATUS.UNINITIALIZED);
  });

  it('rejects a count beyond the allocated capacity', () => {
    const ex = load();
    ex.particle_init(32);
    expect(particleStep(ex, 32)).toBeGreaterThanOrEqual(0);
    expect(particleStep(ex, 33)).toBe(-WASM_STATUS.CAPACITY);
    expect(particleStep(ex, 1 << 24)).toBe(-WASM_STATUS.CAPACITY);
  });

  it('a rejected step writes nothing', () => {
    const ex = load();
    ex.particle_init(16);
    const px = new Float32Array(ex.memory.buffer, ex.pp_px(), 24);
    const life = new Float32Array(ex.memory.buffer, ex.pp_life(), 24);
    px.fill(7);
    life.fill(1);
    const beforePx = Array.from(px);
    const beforeLife = Array.from(life);
    expect(particleStep(ex, 17)).toBe(-WASM_STATUS.CAPACITY);
    // The caller gathers into these arrays before stepping, so if a rejected
    // call were scattered back the simulation would freeze while still looking
    // like a successful frame.
    expect(Array.from(px)).toEqual(beforePx);
    expect(Array.from(life)).toEqual(beforeLife);
  });

  it('a rejection is distinguishable from both success values', () => {
    const ex = load();
    ex.particle_init(8);
    // `life` is zero-filled by the allocator, and the fused pending check skips
    // dead particles — so without this every step would report 0 and the "not
    // pending" case would pass for the wrong reason.
    const life = new Float32Array(ex.memory.buffer, ex.pp_life(), 16);
    life.fill(1);

    // All at rest on their origin => 0 (nothing pending). Displaced => 1.
    expect(particleStep(ex, 8)).toBe(0);

    const px = new Float32Array(ex.memory.buffer, ex.pp_px(), 16);
    px[0] = 400;
    expect(particleStep(ex, 8)).toBe(1);

    // Neither success value is negative, so `flag < 0` is an unambiguous test.
    expect(particleStep(ex, 99)).toBeLessThan(0);
  });
});

// Capacity size arithmetic: `capacity + 8` and the byte-size products used to be
// unchecked, so a hostile count wrapped on wasm32 release (allocating a tiny
// store the kernels then overran — heap corruption, not a trap) and panicked in
// debug. Every `*_init` must now reject with STATUS_OVERFLOW instead, leaving
// the previous allocation untouched.
describe.skipIf(!haveWasm)('init size-overflow rejection', () => {
  it('rejects a transform capacity whose +8 pad wraps', () => {
    const ex = load();
    // On wasm32 usize, capacity + 8 wraps for this count (JS passes it through
    // ToInt32 as 2^32 - 4).
    expect(ex.init(2 ** 32 - 4, 16)).toBe(WASM_STATUS.OVERFLOW);
    // And one whose byte size n * 8 wraps.
    expect(ex.init(2 ** 32 - 12, 16)).toBe(WASM_STATUS.OVERFLOW);
    // A normal init still succeeds afterwards.
    expect(ex.init(64, 8)).toBe(WASM_STATUS.OK);
  });

  it('rejects anim/particle capacities with the same wrap', () => {
    const ex = load();
    expect(ex.anim_init(2 ** 32 - 4, 4)).toBe(WASM_STATUS.OVERFLOW);
    expect(ex.particle_init(2 ** 32 - 4)).toBe(WASM_STATUS.OVERFLOW);
    expect(ex.anim_init(4, 4)).toBe(WASM_STATUS.OK);
    expect(ex.particle_init(4)).toBe(WASM_STATUS.OK);
  });

  it('a rejected init leaves the previous store usable', () => {
    const ex = load();
    ex.init(16, 4);
    // Establish a known-good frame.
    const x = new Float64Array(ex.memory.buffer, ex.p_x(), 24);
    x[1] = 5;
    writeRun(ex, 0, 0, 1, 1);
    expect(ex.set_run_count(1)).toBe(WASM_STATUS.OK);
    expect(ex.compose_scalar()).toBe(WASM_STATUS.OK);

    // Reject a hostile growth: the old store (and its run table) must stay
    // live, not be freed and replaced by a wrapped tiny allocation.
    expect(ex.init(2 ** 32 - 4, 16)).toBe(WASM_STATUS.OVERFLOW);
    expect(ex.compose_scalar()).toBe(WASM_STATUS.OK);
  });
});
