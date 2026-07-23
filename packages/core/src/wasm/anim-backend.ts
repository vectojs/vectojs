/**
 * WASM batched-animation backend: advances every currently-active `SpringDriver`/
 * `TweenDriver` in one call each (`spring_step`/`tween_step`), instead of the JS
 * per-driver `driver.tick()` loop. This is an invisible accelerator — the JS tick
 * loop ({@link Entity.tickDrivers}) is the permanent fallback, so a caller that
 * cannot instantiate WASM, or whose active-driver count never crosses the gate
 * (see `Scene._tickBatchedDrivers`), simply keeps using it.
 *
 * The kernel (`crates/vectojs-core-rs/src/anim.rs`) is bit-identical to
 * `SpringPhysics.update` for springs; tweens match to ~1e-9 (not bit-exact — a
 * `Math.pow`-vs-`powi` ULP difference recorded as a spike finding), which is why
 * a WASM-batched tween needs a `retarget`-style resync, not raw byte reuse.
 *
 * Unlike the transform/hit-test stores, this backend holds no cross-frame
 * residency: every qualifying frame re-gathers ALL currently-active batchable
 * drivers into a fresh dense pack (see {@link ensure} + the spring/tween input
 * views), runs the kernel once, and scatters results straight back out. This
 * keeps the design robust to drivers joining/leaving between frames and to the
 * gate itself flipping the JS/WASM path frame-to-frame — there is no persistent
 * wasm-side state to invalidate.
 */

/** The raw C ABI the crate (`crates/vectojs-core-rs/src/anim.rs`) exports. */
interface AnimExports {
  memory: WebAssembly.Memory;
  anim_init(springCap: number, tweenCap: number): void;
  spring_step(dt: number, count: number): void;
  tween_step(dt: number, count: number): void;
  p_s_val(): number;
  p_s_target(): number;
  p_s_vel(): number;
  p_s_stiff(): number;
  p_s_damp(): number;
  p_s_mass(): number;
  p_t_from(): number;
  p_t_to(): number;
  p_t_elapsed(): number;
  p_t_dur(): number;
  p_t_delay(): number;
  p_t_ease(): number;
  p_t_val(): number;
}

const PAD = 8;

export interface SpringView {
  val: Float64Array;
  target: Float64Array;
  vel: Float64Array;
  stiff: Float64Array;
  damp: Float64Array;
  mass: Float64Array;
}

export interface TweenView {
  from: Float64Array;
  to: Float64Array;
  elapsed: Float64Array;
  dur: Float64Array;
  delay: Float64Array;
  ease: Float64Array;
  val: Float64Array;
}

export class AnimBackend {
  private readonly ex: AnimExports;
  private springCap = 0;
  private tweenCap = 0;
  private sv!: SpringView;
  private tv!: TweenView;

  constructor(instance: WebAssembly.Instance) {
    this.ex = instance.exports as unknown as AnimExports;
  }

  /** The resident spring SoA input/output views, valid until the next capacity
   *  growth. Write gathered driver state here before calling {@link stepSprings}. */
  springView(): SpringView {
    return this.sv;
  }

  /** The resident tween SoA input/output views, valid until the next capacity
   *  growth. Write gathered driver state here before calling {@link stepTweens}. */
  tweenView(): TweenView {
    return this.tv;
  }

  /**
   * Size (and grow, if needed) capacity for `springCount` springs and
   * `tweenCount` tweens. Call this BEFORE writing into {@link springView}/
   * {@link tweenView} — a capacity growth detaches the previous views, so
   * writing first and sizing after would write into a stale buffer.
   */
  ensure(springCount: number, tweenCount: number): void {
    if (springCount + PAD <= this.springCap && tweenCount + PAD <= this.tweenCap) return;
    this.springCap = springCount + PAD;
    this.tweenCap = tweenCount + PAD;
    this.ex.anim_init(this.springCap, this.tweenCap);
    this.refreshViews();
  }

  /** Advance `count` springs (from index 0) by `dtMs` milliseconds, in place. */
  stepSprings(dtMs: number, count: number): void {
    this.ex.spring_step(dtMs / 1000, count); // kernel integrates in seconds, matching SpringPhysics
  }

  /** Advance `count` tweens (from index 0) by `dtMs` milliseconds, writing `val`. */
  stepTweens(dtMs: number, count: number): void {
    this.ex.tween_step(dtMs, count);
  }

  private refreshViews(): void {
    const buf = this.ex.memory.buffer;
    const sCap = this.springCap;
    const tCap = this.tweenCap;
    this.sv = {
      val: new Float64Array(buf, this.ex.p_s_val(), sCap),
      target: new Float64Array(buf, this.ex.p_s_target(), sCap),
      vel: new Float64Array(buf, this.ex.p_s_vel(), sCap),
      stiff: new Float64Array(buf, this.ex.p_s_stiff(), sCap),
      damp: new Float64Array(buf, this.ex.p_s_damp(), sCap),
      mass: new Float64Array(buf, this.ex.p_s_mass(), sCap),
    };
    this.tv = {
      from: new Float64Array(buf, this.ex.p_t_from(), tCap),
      to: new Float64Array(buf, this.ex.p_t_to(), tCap),
      elapsed: new Float64Array(buf, this.ex.p_t_elapsed(), tCap),
      dur: new Float64Array(buf, this.ex.p_t_dur(), tCap),
      delay: new Float64Array(buf, this.ex.p_t_delay(), tCap),
      ease: new Float64Array(buf, this.ex.p_t_ease(), tCap),
      val: new Float64Array(buf, this.ex.p_t_val(), tCap),
    };
  }
}

/**
 * Instantiate synchronously (Node/tests, or a worker). Rejected on the browser
 * main thread for modules >4 KB — use {@link instantiateAsync} there. Returns
 * `null` if compilation/instantiation throws, so callers fall back to JS.
 */
export function instantiateSync(bytes: BufferSource): AnimBackend | null {
  try {
    const module = new WebAssembly.Module(bytes);
    const instance = new WebAssembly.Instance(module, {});
    return new AnimBackend(instance);
  } catch {
    return null;
  }
}

/**
 * Instantiate asynchronously (browser main thread). Returns `null` on any
 * failure — CSP `wasm-unsafe-eval`, unsupported, corrupt/missing bytes — so the
 * caller keeps using the JS path.
 */
export async function instantiateAsync(bytes: BufferSource): Promise<AnimBackend | null> {
  try {
    const { instance } = await WebAssembly.instantiate(bytes, {});
    return new AnimBackend(instance);
  } catch {
    return null;
  }
}

/** Anything the anim core can be loaded from, matching the transform/hit-test
 *  cores' loading ergonomics. */
export type AnimModuleSource = BufferSource | string | URL | Response | Promise<Response>;

/**
 * Instantiate from a URL/Response using streaming compilation when the
 * platform supports it, falling back to fetch → arrayBuffer → instantiate when
 * unavailable or the response's MIME type is rejected. Returns `null` on any
 * failure so the caller keeps the JS path.
 */
export async function instantiateStreaming(
  source: string | URL | Response | Promise<Response>,
): Promise<AnimBackend | null> {
  try {
    const resp =
      typeof source === 'string' || source instanceof URL
        ? await fetch(String(source))
        : await source;

    if (typeof WebAssembly.instantiateStreaming === 'function') {
      const buffered = resp.clone();
      try {
        const { instance } = await WebAssembly.instantiateStreaming(resp, {});
        return new AnimBackend(instance);
      } catch {
        const { instance } = await WebAssembly.instantiate(await buffered.arrayBuffer(), {});
        return new AnimBackend(instance);
      }
    }

    const { instance } = await WebAssembly.instantiate(await resp.arrayBuffer(), {});
    return new AnimBackend(instance);
  } catch {
    return null;
  }
}
