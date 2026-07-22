/**
 * WASM transform backend: uploads a {@link TransformStore}, runs the f64x2 SIMD
 * kernel, and reads world matrices back. This is an invisible accelerator —
 * {@link composeJS} computes the identical result and is the permanent fallback,
 * so a caller that cannot instantiate WASM (CSP, no SIMD, missing asset) simply
 * keeps using the JS path. Failure is the default state, not an error path.
 *
 * The seam is two batched crossings per compose (upload, readback), never per
 * entity: at ~12-31 ns/crossing a per-entity call at 100k would cost >1 ms/frame.
 */
import type { TransformStore } from './soa';

/** The raw C ABI the crate (`crates/vectojs-core-rs`) exports. */
interface CoreExports {
  memory: WebAssembly.Memory;
  init(capacity: number, maxRuns: number): void;
  set_run_count(n: number): void;
  compose_simd(): void;
  compose_scalar(): void;
  p_x(): number;
  p_y(): number;
  p_sx(): number;
  p_sy(): number;
  p_cos(): number;
  p_sin(): number;
  p_opacity(): number;
  p_wa(): number;
  p_wb(): number;
  p_wc(): number;
  p_wd(): number;
  p_we(): number;
  p_wf(): number;
  p_wo(): number;
  p_run_parent(): number;
  p_run_start(): number;
  p_run_len(): number;
}

/** Which kernel to run. `simd` is the default; `scalar` exists for A/B and for
 *  the (theoretical) case of a build without simd128. Both are f64 and
 *  bit-identical to {@link composeJS}. */
export type Kernel = 'simd' | 'scalar';

const PAD = 8;

/**
 * A live WASM backend bound to one module instance. `compose` is allocation-free
 * after the first call at a given high-water capacity; growing past it re-`init`s
 * and re-views memory (a `WebAssembly.Memory.buffer` detaches on growth, so the
 * typed-array views must be rebuilt then — done here, never mid-compose).
 */
export class WasmTransformBackend {
  readonly available = true as const;
  private readonly ex: CoreExports;
  private cap = 0;
  private runCap = 0;
  // Views over wasm linear memory, valid until the next init().
  private vx!: Float64Array;
  private vy!: Float64Array;
  private vsx!: Float64Array;
  private vsy!: Float64Array;
  private vcos!: Float64Array;
  private vsin!: Float64Array;
  private vop!: Float64Array;
  private vwa!: Float64Array;
  private vwb!: Float64Array;
  private vwc!: Float64Array;
  private vwd!: Float64Array;
  private vwe!: Float64Array;
  private vwf!: Float64Array;
  private vwo!: Float64Array;
  private vrp!: Int32Array;
  private vrs!: Int32Array;
  private vrl!: Int32Array;

  constructor(instance: WebAssembly.Instance) {
    this.ex = instance.exports as unknown as CoreExports;
  }

  /** Compose world matrices for `store` in WASM, writing back into its
   *  `wa..wo` arrays. Result is bit-identical to `composeJS(store)`. */
  compose(store: TransformStore, kernel: Kernel = 'simd'): void {
    this.ensure(store.count, store.runCount);
    const n = store.count;

    // Upload inputs (n slots; wasm padding beyond n is untouched and never read
    // back — a SIMD tail lane may read it but its result is discarded and does
    // not affect the real lane).
    this.vx.set(store.x.subarray(0, n));
    this.vy.set(store.y.subarray(0, n));
    this.vsx.set(store.sx.subarray(0, n));
    this.vsy.set(store.sy.subarray(0, n));
    this.vcos.set(store.cos.subarray(0, n));
    this.vsin.set(store.sin.subarray(0, n));
    this.vop.set(store.opacity.subarray(0, n));

    const rc = store.runCount;
    this.vrp.set(store.runParent.subarray(0, rc));
    this.vrs.set(store.runStart.subarray(0, rc));
    this.vrl.set(store.runLen.subarray(0, rc));
    this.ex.set_run_count(rc);

    if (kernel === 'scalar') this.ex.compose_scalar();
    else this.ex.compose_simd();

    // Read world matrices back.
    store.wa.set(this.vwa.subarray(0, n));
    store.wb.set(this.vwb.subarray(0, n));
    store.wc.set(this.vwc.subarray(0, n));
    store.wd.set(this.vwd.subarray(0, n));
    store.we.set(this.vwe.subarray(0, n));
    store.wf.set(this.vwf.subarray(0, n));
    store.wo.set(this.vwo.subarray(0, n));
  }

  private ensure(count: number, runCount: number): void {
    if (count + PAD <= this.cap && runCount <= this.runCap) return;
    this.cap = count + PAD;
    this.runCap = Math.max(runCount, count, 1);
    this.ex.init(count, this.runCap); // crate pads capacity by +PAD internally
    this.refreshViews();
  }

  /** Rebuild typed-array views after an init() (which may have grown, and thus
   *  detached, the memory buffer). */
  private refreshViews(): void {
    const buf = this.ex.memory.buffer;
    const cap = this.cap;
    const rc = this.runCap;
    const f64 = (ptr: number): Float64Array => new Float64Array(buf, ptr, cap);
    const i32 = (ptr: number): Int32Array => new Int32Array(buf, ptr, rc);
    this.vx = f64(this.ex.p_x());
    this.vy = f64(this.ex.p_y());
    this.vsx = f64(this.ex.p_sx());
    this.vsy = f64(this.ex.p_sy());
    this.vcos = f64(this.ex.p_cos());
    this.vsin = f64(this.ex.p_sin());
    this.vop = f64(this.ex.p_opacity());
    this.vwa = f64(this.ex.p_wa());
    this.vwb = f64(this.ex.p_wb());
    this.vwc = f64(this.ex.p_wc());
    this.vwd = f64(this.ex.p_wd());
    this.vwe = f64(this.ex.p_we());
    this.vwf = f64(this.ex.p_wf());
    this.vwo = f64(this.ex.p_wo());
    this.vrp = i32(this.ex.p_run_parent());
    this.vrs = i32(this.ex.p_run_start());
    this.vrl = i32(this.ex.p_run_len());
  }
}

/**
 * Instantiate synchronously (Node/tests, or a worker). Rejected on the browser
 * main thread for modules >4 KB — use {@link instantiateAsync} there. Returns
 * `null` if compilation/instantiation throws, so callers fall back to JS.
 */
export function instantiateSync(bytes: BufferSource): WasmTransformBackend | null {
  try {
    const module = new WebAssembly.Module(bytes);
    const instance = new WebAssembly.Instance(module, {});
    return new WasmTransformBackend(instance);
  } catch {
    return null;
  }
}

/**
 * Instantiate asynchronously (browser main thread). Returns `null` on any
 * failure — CSP `wasm-unsafe-eval`, unsupported SIMD, corrupt/missing bytes —
 * so the caller keeps using the JS path. This is the loader the Scene hot-swap
 * (gated integration) will await.
 */
export async function instantiateAsync(bytes: BufferSource): Promise<WasmTransformBackend | null> {
  try {
    const { instance } = await WebAssembly.instantiate(bytes, {});
    return new WasmTransformBackend(instance);
  } catch {
    return null;
  }
}
