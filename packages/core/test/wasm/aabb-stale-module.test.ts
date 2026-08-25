// @vitest-environment node
// A stale published .wasm (one fixed URL, cacheable by CDNs and browsers) can
// instantiate cleanly yet predate `compute_aabbs_simd`. Before the guard this
// threw a TypeError mid-render; now `runAabbs` probes the export and downgrades
// to the bit-identical scalar kernel (#784 follow-up hardening).
import { describe, it, expect, vi } from 'vitest';
import { WasmTransformBackend, WASM_STATUS } from '../../src/wasm/backend';

interface RecordedCalls {
  scalar: number;
  simd: number;
}

function makeExports(hasSimd: boolean): {
  ex: Record<string, unknown>;
  calls: RecordedCalls;
} {
  const calls: RecordedCalls = { scalar: 0, simd: 0 };
  const ex: Record<string, unknown> = {
    memory: new WebAssembly.Memory({ initial: 1 }),
    compute_aabbs: vi.fn((count: number) => {
      calls.scalar++;
      return count >= 0 ? WASM_STATUS.OK : WASM_STATUS.CAPACITY;
    }),
  };
  if (hasSimd) {
    ex.compute_aabbs_simd = vi.fn((count: number) => {
      calls.simd++;
      return count >= 0 ? WASM_STATUS.OK : WASM_STATUS.CAPACITY;
    });
  }
  return { ex, calls };
}

function instantiate(hasSimd: boolean): {
  backend: WasmTransformBackend;
  calls: RecordedCalls;
} {
  const { ex, calls } = makeExports(hasSimd);
  // The constructor only casts `instance.exports`; no view building happens
  // until an upload path runs, so a partial export surface is enough here.
  const backend = new WasmTransformBackend({
    exports: ex,
  } as unknown as WebAssembly.Instance);
  return { backend, calls };
}

describe('runAabbs vs a stale module lacking compute_aabbs_simd', () => {
  it("default 'simd' kernel falls back to the scalar pass instead of throwing", () => {
    const { backend, calls } = instantiate(false);
    expect(backend.runAabbs(4)).toBe(true); // was: TypeError mid-render
    expect(backend.lastStatus).toBe(WASM_STATUS.OK);
    expect(calls.scalar).toBe(1);
    expect(calls.simd).toBe(0);
  });

  it('an explicit scalar request is unchanged', () => {
    const { backend, calls } = instantiate(false);
    expect(backend.runAabbs(4, 'scalar')).toBe(true);
    expect(calls.scalar).toBe(1);
    expect(calls.simd).toBe(0);
  });

  it('a healthy module still takes the SIMD kernel by default', () => {
    const { backend, calls } = instantiate(true);
    expect(backend.runAabbs(4)).toBe(true);
    expect(calls.simd).toBe(1);
    expect(calls.scalar).toBe(0);
  });

  it('the downgrade keeps the numeric rejection telemetry intact', () => {
    const { backend, calls } = instantiate(false);
    expect(backend.runAabbs(-1)).toBe(false);
    expect(backend.lastStatus).toBe(WASM_STATUS.CAPACITY);
    expect(calls.scalar).toBe(1);
  });
});
