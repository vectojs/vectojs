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
  init(capacity: number, maxRuns: number): void;
  set_run_count(n: number): number;
  compose_simd(): number;
  compose_scalar(): number;
  compute_aabbs(count: number): number;
  p_run_parent(): number;
  p_run_start(): number;
  p_run_len(): number;
  p_wa(): number;
  p_x(): number;
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
