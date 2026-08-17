/**
 * WASM Barnes-Hut force backend for `VectoForceLayout`. Replaces the octree
 * build + repulsion-accumulation phase (the measured 78–90% of a tick) with a
 * single `force_step` call; link springs, centering, velocity-decay integration
 * and pins stay in the JS tick. The JS `BarnesHutOctree` is the permanent
 * fallback and the differential oracle — the kernel (`crates/vectojs-force-rs`)
 * must produce bit-identical f64 accelerations.
 *
 * This is a self-contained local loader (~50 lines), not a shared
 * `@vectojs/wasm-loader` package: `@vectojs/graph3d`'s only peer is `three`, and
 * a shared package is not worth it until a third WASM consumer appears
 * (DEC-0081).
 */

/** The raw C ABI the crate exports. Status codes mirror `WASM_STATUS`. */
interface ForceExports {
  memory: WebAssembly.Memory;
  /** Allocate for `capacity` nodes. 0 = ok, non-zero = rejected. */
  force_init(capacity: number): number;
  /** Pointer to the f32 position gather buffer (n*3). */
  force_pos(): number;
  /** Pointer to the f64 acceleration output buffer (n*3). */
  force_accel(): number;
  /** Build + accumulate. 0 = ok, non-zero = rejected (nothing written). */
  force_step(n: number, theta: number): number;
}

const STATUS_OK = 0;

/**
 * True when the backend's resident typed-array views must be rebuilt: the
 * shared `WebAssembly.Memory` buffer they were constructed over has been
 * detached (reads as `byteLength === 0`) or replaced — the octree can grow the
 * linear memory mid-step on a pathological insert path, which detaches the
 * views.
 */
function viewsStale(cap: number, probe: ArrayBufferView, memory: WebAssembly.Memory): boolean {
  if (cap === 0) return false;
  return probe.byteLength === 0 || probe.buffer !== memory.buffer;
}

export class ForceBackend {
  private readonly ex: ForceExports;
  private cap = 0;
  private posView!: Float32Array;
  private accelView!: Float64Array;

  constructor(instance: WebAssembly.Instance) {
    this.ex = instance.exports as unknown as ForceExports;
  }

  /** Size (and grow, if needed) the buffers for `count` nodes. */
  ensure(count: number): void {
    if (count <= this.cap) return;
    if (this.ex.force_init(count) !== STATUS_OK) return;
    this.cap = count;
    this.refreshViews();
  }

  /**
   * Gather the positions, run one build + accumulate, and return the f64
   * acceleration view (xyz triplets in node order), or `null` when the kernel
   * rejected the call (nothing written) — the caller keeps the JS tick.
   */
  step(positions: Float32Array, n: number, theta: number): Float64Array | null {
    if (n > this.cap) {
      this.ensure(n);
      if (n > this.cap) return null;
    }
    this.posView.set(positions.subarray(0, n * 3));
    if (this.ex.force_step(n, theta) !== STATUS_OK) return null;
    if (viewsStale(this.cap, this.accelView, this.ex.memory)) this.refreshViews();
    return this.accelView;
  }

  private refreshViews(): void {
    const buf = this.ex.memory.buffer;
    this.posView = new Float32Array(buf, this.ex.force_pos(), this.cap * 3);
    this.accelView = new Float64Array(buf, this.ex.force_accel(), this.cap * 3);
  }
}

/** Instantiate synchronously (Node/tests). Returns `null` on failure so callers
 *  fall back to the JS Barnes-Hut. */
export function instantiateSync(bytes: BufferSource): ForceBackend | null {
  try {
    const module = new WebAssembly.Module(bytes);
    const instance = new WebAssembly.Instance(module, {});
    return new ForceBackend(instance);
  } catch {
    return null;
  }
}

/** Anything the force module can be loaded from. */
export type ForceModuleSource = BufferSource | string | URL | Response | Promise<Response>;

/** Instantiate from a URL/Response with streaming compilation when available,
 *  falling back to fetch -> arrayBuffer -> instantiate. Returns `null` on any
 *  failure so the caller keeps the JS path. */
async function instantiateStreaming(
  source: string | URL | Response | Promise<Response>,
): Promise<ForceBackend | null> {
  try {
    const resp =
      typeof source === 'string' || source instanceof URL
        ? await fetch(String(source))
        : await source;
    if (typeof WebAssembly.instantiateStreaming === 'function') {
      const buffered = resp.clone();
      try {
        const { instance } = await WebAssembly.instantiateStreaming(resp, {});
        return new ForceBackend(instance);
      } catch {
        const { instance } = await WebAssembly.instantiate(await buffered.arrayBuffer(), {});
        return new ForceBackend(instance);
      }
    }
    const { instance } = await WebAssembly.instantiate(await resp.arrayBuffer(), {});
    return new ForceBackend(instance);
  } catch {
    return null;
  }
}

/** Instantiate a force backend from bytes (sync) or a URL/Response (async).
 *  Returns `null` on any failure so the caller keeps the JS Barnes-Hut. */
export async function instantiateForceBackend(
  source: ForceModuleSource,
): Promise<ForceBackend | null> {
  if (source instanceof ArrayBuffer || ArrayBuffer.isView(source)) {
    return instantiateSync(source);
  }
  return instantiateStreaming(source);
}
