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

/**
 * Status codes returned by the crate's fallible exports, mirroring the `STATUS_*`
 * constants in `crates/vectojs-core-rs/src/lib.rs`.
 *
 * The kernels used to trust their arguments completely — the Safety contracts
 * were enforced only by this file's calling convention, and PR #136's review
 * found two out-of-bounds read paths that way. Now a rejected call writes nothing
 * and reports why, so a bad batch degrades to the JS path instead of rendering
 * from a half-written store.
 */
export const WASM_STATUS = {
  OK: 0,
  /** A count exceeded what `init` allocated. */
  CAPACITY: 1,
  /** A kernel ran before `init`. */
  UNINITIALIZED: 2,
  /** A sibling run addressed a slot or parent outside the store. */
  BAD_RUN: 3,
} as const;

/** The raw C ABI the crate (`crates/vectojs-core-rs`) exports. */
interface CoreExports {
  memory: WebAssembly.Memory;
  init(capacity: number, maxRuns: number): void;
  /** Returns a status code: 0 = ok, non-zero = rejected (see WASM_STATUS). */
  set_run_count(n: number): number;
  compose_simd(): number;
  compose_scalar(): number;
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
  compute_aabbs(count: number): void;
  p_bx(): number;
  p_by(): number;
  p_bw(): number;
  p_bh(): number;
  p_aminx(): number;
  p_aminy(): number;
  p_amaxx(): number;
  p_amaxy(): number;
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
  private vbx!: Float64Array;
  private vby!: Float64Array;
  private vbw!: Float64Array;
  private vbh!: Float64Array;
  private vaminx!: Float64Array;
  private vaminy!: Float64Array;
  private vamaxx!: Float64Array;
  private vamaxy!: Float64Array;
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
    if (this.ex.set_run_count(rc) !== WASM_STATUS.OK) {
      this.lastStatus = WASM_STATUS.CAPACITY;
      return;
    }

    const status = kernel === 'scalar' ? this.ex.compose_scalar() : this.ex.compose_simd();
    this.lastStatus = status;
    // A rejected kernel wrote nothing, so reading back would copy stale matrices
    // over the caller's store and silently render the previous frame's geometry.
    if (status !== WASM_STATUS.OK) return;

    // Read world matrices back.
    store.wa.set(this.vwa.subarray(0, n));
    store.wb.set(this.vwb.subarray(0, n));
    store.wc.set(this.vwc.subarray(0, n));
    store.wd.set(this.vwd.subarray(0, n));
    store.we.set(this.vwe.subarray(0, n));
    store.wf.set(this.vwf.subarray(0, n));
    store.wo.set(this.vwo.subarray(0, n));
  }

  /**
   * Run the kernel only, over data already resident in WASM memory — no upload,
   * no readback. This is the per-frame cost the *designed* integration pays:
   * entity accessors write `x/y/rotation` straight into the wasm input views
   * (via {@link inputView}) and the renderer reads world matrices straight from
   * the wasm output views (via {@link worldView}), so the batch copies in
   * {@link compose} do not happen every frame. `compose` must have run at least
   * once at the current capacity to size the store and set the run count; call
   * {@link uploadRuns} after a topology change.
   */
  runKernel(kernel: Kernel = 'simd'): number {
    const status = kernel === 'scalar' ? this.ex.compose_scalar() : this.ex.compose_simd();
    this.lastStatus = status;
    return status;
  }

  /** Upload only the run table + count (topology), leaving per-entity inputs to
   *  the resident views. Call when the tree structure changes, not per frame. */
  uploadRuns(store: TransformStore): void {
    this.ensure(store.count, store.runCount);
    const rc = store.runCount;
    this.vrp.set(store.runParent.subarray(0, rc));
    this.vrs.set(store.runStart.subarray(0, rc));
    this.vrl.set(store.runLen.subarray(0, rc));
    this.lastStatus = this.ex.set_run_count(rc);
  }

  /**
   * Status of the most recent kernel or run-table call. `WASM_STATUS.OK` unless
   * the crate rejected its arguments, in which case that call was a no-op.
   */
  public lastStatus: number = WASM_STATUS.OK;

  /** The resident wasm input views (`x,y,sx,sy,cos,sin,opacity`), valid until
   *  the next capacity growth. Writing here is what makes uploads unnecessary. */
  inputView(): {
    x: Float64Array;
    y: Float64Array;
    sx: Float64Array;
    sy: Float64Array;
    cos: Float64Array;
    sin: Float64Array;
    opacity: Float64Array;
  } {
    return {
      x: this.vx,
      y: this.vy,
      sx: this.vsx,
      sy: this.vsy,
      cos: this.vcos,
      sin: this.vsin,
      opacity: this.vop,
    };
  }

  /** The resident wasm world-matrix output views (`wa..wo`). Reading here is
   *  what makes readback unnecessary. */
  worldView(): {
    wa: Float64Array;
    wb: Float64Array;
    wc: Float64Array;
    wd: Float64Array;
    we: Float64Array;
    wf: Float64Array;
    wo: Float64Array;
  } {
    return {
      wa: this.vwa,
      wb: this.vwb,
      wc: this.vwc,
      wd: this.vwd,
      we: this.vwe,
      wf: this.vwf,
      wo: this.vwo,
    };
  }

  /**
   * Compute world-space AABBs for `store` in WASM (G1+), writing back into its
   * `aminx/aminy/amaxx/amaxy` arrays. Uploads the local bounds, runs the AABB
   * pass, reads results back. Result is bit-identical to `computeAabbsJS(store)`.
   * `compose` (or `runKernel`) must have populated the world matrices first —
   * this pass reads them. For the resident (no-copy) integration, write bounds
   * via {@link boundsView} and read via {@link aabbView} + call
   * {@link runAabbs} instead.
   */
  computeAabbs(store: TransformStore): void {
    this.ensure(store.count, store.runCount);
    const n = store.count;
    this.vbx.set(store.bx.subarray(0, n));
    this.vby.set(store.by.subarray(0, n));
    this.vbw.set(store.bw.subarray(0, n));
    this.vbh.set(store.bh.subarray(0, n));
    this.ex.compute_aabbs(n);
    store.aminx.set(this.vaminx.subarray(0, n));
    store.aminy.set(this.vaminy.subarray(0, n));
    store.amaxx.set(this.vamaxx.subarray(0, n));
    store.amaxy.set(this.vamaxy.subarray(0, n));
  }

  /** Run the AABB pass only, over `count` entities already resident in wasm
   *  memory (bounds written via {@link boundsView}, world matrices already
   *  composed). No upload/readback — the per-frame resident path. */
  runAabbs(count: number): void {
    this.ex.compute_aabbs(count);
  }

  /** Resident wasm local-bounds input views (`bx,by,bw,bh`) for the AABB pass. */
  boundsView(): {
    bx: Float64Array;
    by: Float64Array;
    bw: Float64Array;
    bh: Float64Array;
  } {
    return { bx: this.vbx, by: this.vby, bw: this.vbw, bh: this.vbh };
  }

  /** Resident wasm world-AABB output views (`aminx,aminy,amaxx,amaxy`). */
  aabbView(): {
    aminx: Float64Array;
    aminy: Float64Array;
    amaxx: Float64Array;
    amaxy: Float64Array;
  } {
    return {
      aminx: this.vaminx,
      aminy: this.vaminy,
      amaxx: this.vamaxx,
      amaxy: this.vamaxy,
    };
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
    this.vbx = f64(this.ex.p_bx());
    this.vby = f64(this.ex.p_by());
    this.vbw = f64(this.ex.p_bw());
    this.vbh = f64(this.ex.p_bh());
    this.vaminx = f64(this.ex.p_aminx());
    this.vaminy = f64(this.ex.p_aminy());
    this.vamaxx = f64(this.ex.p_amaxx());
    this.vamaxy = f64(this.ex.p_amaxy());
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

/**
 * Anything the transform core can be loaded from: raw bytes, a URL/path string
 * or {@link URL} to fetch, or a {@link Response} (or a promise of one) — e.g.
 * `fetch(new URL('./vectojs_core.wasm', import.meta.url))`, the shape every
 * bundler emits for a co-located `.wasm` asset.
 */
export type WasmModuleSource = BufferSource | string | URL | Response | Promise<Response>;

/**
 * Instantiate from a URL/Response using streaming compilation when the platform
 * supports it (the module compiles while it downloads — the fastest cold start),
 * and transparently falling back to fetch → arrayBuffer → instantiate when
 * `WebAssembly.instantiateStreaming` is unavailable or the response's MIME type
 * is not `application/wasm` (some engines reject the stream in that case, e.g. a
 * dev server serving `application/octet-stream`). Returns `null` on any failure
 * so the caller keeps the JS path — loading the accelerator is never an error path.
 */
export async function instantiateStreaming(
  source: string | URL | Response | Promise<Response>,
): Promise<WasmTransformBackend | null> {
  try {
    const resp =
      typeof source === 'string' || source instanceof URL
        ? await fetch(String(source))
        : await source;

    if (typeof WebAssembly.instantiateStreaming === 'function') {
      // Keep an untouched clone: a failed streaming attempt has consumed `resp`.
      const buffered = resp.clone();
      try {
        const { instance } = await WebAssembly.instantiateStreaming(resp, {});
        return new WasmTransformBackend(instance);
      } catch {
        const { instance } = await WebAssembly.instantiate(await buffered.arrayBuffer(), {});
        return new WasmTransformBackend(instance);
      }
    }

    const { instance } = await WebAssembly.instantiate(await resp.arrayBuffer(), {});
    return new WasmTransformBackend(instance);
  } catch {
    return null;
  }
}
