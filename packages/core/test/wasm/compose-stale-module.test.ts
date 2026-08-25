// @vitest-environment node
// A stale published .wasm (one fixed URL, cacheable by CDNs and browsers) can
// instantiate cleanly yet predate `compose_simd`. Before the guard this threw a
// TypeError mid-render from `compose` and `runKernel`; now both probe the
// export and downgrade to the bit-identical scalar kernel (#798 fixed the same
// gap for `compute_aabbs_simd`).
import { describe, it, expect, vi } from 'vitest';
import { WasmTransformBackend, WASM_STATUS } from '../../src/wasm/backend';
import { buildStore, type InputNode } from '../../src/wasm/soa';

interface RecordedCalls {
  scalar: number;
  simd: number;
}

/** Byte offset of export slot k: 25 slots of 1 KiB inside one 64 KiB page. */
const SLOT = (k: number) => k * 1024;

function makeExports(hasSimd: boolean): {
  ex: Record<string, unknown>;
  calls: RecordedCalls;
  memory: WebAssembly.Memory;
  scalarMock: ReturnType<typeof vi.fn>;
} {
  const calls: RecordedCalls = { scalar: 0, simd: 0 };
  const memory = new WebAssembly.Memory({ initial: 1 });
  // `compose` builds its typed-array views over these pointers via
  // refreshViews(); every slot stays well clear of its 1 KiB neighbours.
  const ptrs: Array<[string, number]> = [
    ['p_x', 0],
    ['p_y', 1],
    ['p_sx', 2],
    ['p_sy', 3],
    ['p_cos', 4],
    ['p_sin', 5],
    ['p_opacity', 6],
    ['p_wa', 7],
    ['p_wb', 8],
    ['p_wc', 9],
    ['p_wd', 10],
    ['p_we', 11],
    ['p_wf', 12],
    ['p_wo', 13],
    ['p_bx', 14],
    ['p_by', 15],
    ['p_bw', 16],
    ['p_bh', 17],
    ['p_aminx', 18],
    ['p_aminy', 19],
    ['p_amaxx', 20],
    ['p_amaxy', 21],
    ['p_run_parent', 22],
    ['p_run_start', 23],
    ['p_run_len', 24],
  ];
  const scalarMock = vi.fn(() => {
    calls.scalar++;
    return WASM_STATUS.OK;
  });
  const ex: Record<string, unknown> = {
    memory,
    init: vi.fn(() => WASM_STATUS.OK),
    set_run_count: vi.fn(() => WASM_STATUS.OK),
    compose_scalar: scalarMock,
    ...Object.fromEntries(ptrs.map(([name, k]) => [name, () => SLOT(k)])),
  };
  if (hasSimd) {
    ex.compose_simd = vi.fn(() => {
      calls.simd++;
      return WASM_STATUS.OK;
    });
  }
  return { ex, calls, memory, scalarMock };
}

const NODES: InputNode[] = [
  {
    parent: -1,
    x: 10,
    y: 20,
    scaleX: 2,
    scaleY: 1,
    rotation: 0,
    opacity: 1,
    bx: 0,
    by: 0,
    bw: 8,
    bh: 8,
  },
  {
    parent: 0,
    x: -5,
    y: 3,
    scaleX: 1,
    scaleY: 0.5,
    rotation: Math.PI / 2,
    opacity: 0.5,
    bx: 0,
    by: 0,
    bw: 4,
    bh: 4,
  },
];

function instantiate(hasSimd: boolean): {
  backend: WasmTransformBackend;
  calls: RecordedCalls;
  memory: WebAssembly.Memory;
  scalarMock: ReturnType<typeof vi.fn>;
} {
  const { ex, calls, memory, scalarMock } = makeExports(hasSimd);
  // The constructor only casts `instance.exports`; no view building happens
  // until an upload path runs, so a partial export surface is enough here.
  const backend = new WasmTransformBackend({
    exports: ex,
  } as unknown as WebAssembly.Instance);
  return { backend, calls, memory, scalarMock };
}

describe('compose/runKernel vs a stale module lacking compose_simd', () => {
  it("compose's default 'simd' kernel falls back to the scalar pass instead of throwing", () => {
    const { backend, calls, memory } = instantiate(false);
    // Prove the readback still runs under the downgrade: plant a value in the
    // wasm-side world-matrix slot before composing.
    const waSlot = new Float64Array(memory.buffer, SLOT(7), 16);
    waSlot[0] = 7.5;

    const store = buildStore(NODES);
    expect(() => backend.compose(store)).not.toThrow(); // was: TypeError mid-render
    expect(backend.lastStatus).toBe(WASM_STATUS.OK);
    expect(calls.scalar).toBe(1);
    expect(calls.simd).toBe(0);
    expect(store.wa[0]).toBe(7.5); // readback copied the (mocked) kernel output
  });

  it("runKernel's default 'simd' kernel degrades to scalar on the same module", () => {
    const { backend, calls } = instantiate(false);
    expect(backend.runKernel()).toBe(WASM_STATUS.OK);
    expect(calls.scalar).toBe(1);
    expect(calls.simd).toBe(0);
    expect(backend.lastStatus).toBe(WASM_STATUS.OK);
  });

  it('a healthy module still takes the SIMD kernel by default', () => {
    const { backend, calls } = instantiate(true);
    backend.compose(buildStore(NODES));
    expect(backend.runKernel()).toBe(WASM_STATUS.OK);
    expect(calls.simd).toBe(2);
    expect(calls.scalar).toBe(0);
  });

  it('an explicit scalar request is unchanged', () => {
    const { backend, calls } = instantiate(false);
    const store = buildStore(NODES);
    expect(() => backend.compose(store, 'scalar')).not.toThrow();
    expect(backend.runKernel('scalar')).toBe(WASM_STATUS.OK);
    expect(calls.scalar).toBe(2);
    expect(calls.simd).toBe(0);
  });

  it('the downgrade keeps the numeric rejection telemetry intact', () => {
    const { backend, scalarMock } = instantiate(false);
    scalarMock.mockReturnValue(WASM_STATUS.CAPACITY);

    // runKernel surfaces the kernel status directly.
    expect(backend.runKernel()).toBe(WASM_STATUS.CAPACITY);
    expect(backend.lastStatus).toBe(WASM_STATUS.CAPACITY);

    // compose must NOT read stale matrices back over the caller's store when
    // the (downgraded) kernel rejects.
    const store = buildStore(NODES);
    store.wa[0] = 42;
    backend.compose(store);
    expect(backend.lastStatus).toBe(WASM_STATUS.CAPACITY);
    expect(store.wa[0]).toBe(42); // rejected pass wrote nothing
    // mockReturnValue bypasses the calls bookkeeping; count on the mock itself.
    expect(scalarMock).toHaveBeenCalledTimes(2); // runKernel's + compose's downgraded pass
  });
});
