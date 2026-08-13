/**
 * WASM particle-simulation backend (G4): advances the whole particle buffer for
 * a `ComputeParticleEntity` in one `particle_step` call, instead of the JS
 * per-particle `updateCPU` loop. This is the CPU fallback path — it runs exactly
 * when there is no GPU — so the machines that most need it get the batched
 * kernel. The JS `updateCPU` remains the permanent fallback when WASM cannot
 * instantiate.
 *
 * ## f32, and its own differential oracle
 *
 * The particle buffer is a `Float32Array` (matches the WGSL compute shader), so
 * the kernel (`crates/vectojs-core-rs/src/particle.rs`) commits to **f32** and is
 * NOT bit-comparable to the f64 transform core. Its oracle is
 * {@link particleStepReferenceF32} below — a JS f32 reference that rounds every
 * intermediate to f32 (`Math.fround`) in the same op order and uses
 * `sqrt(dx*dx+dy*dy)` (not `Math.hypot`, which is correctly-rounded f64). With
 * those two rules the reference is bit-identical to the kernel, since f32
 * add/sub/mul/div/sqrt of f32 operands round once whether done in f32 or
 * f64-then-`fround`. (The shipped `updateCPU` stays f64 and differs by <1 ULP
 * per step — the accepted CPU-vs-GPU-class divergence the survey documents.)
 *
 * ## SoA transpose
 *
 * The render/GPU buffer is AoS stride-8. The backend transposes position/
 * velocity/origin/life into per-field f32 arrays ({@link gather}), runs the
 * kernel, and scatters position/velocity/life back ({@link scatter}); origin and
 * `size` never change during the sim.
 */

import {
  PARTICLE_STRIDE_FLOATS,
  PARTICLE_OFFSET_POSITION_X,
  PARTICLE_OFFSET_POSITION_Y,
  PARTICLE_OFFSET_VELOCITY_X,
  PARTICLE_OFFSET_VELOCITY_Y,
  PARTICLE_OFFSET_ORIGIN_X,
  PARTICLE_OFFSET_ORIGIN_Y,
  PARTICLE_OFFSET_LIFE,
} from '../tree/ComputeParticleEntity';
import { WASM_STATUS, viewsStale } from './backend';

/** The raw C ABI the crate exports for the particle kernel. */
interface ParticleExports {
  memory: WebAssembly.Memory;
  particle_init(capacity: number): void;
  /**
   * Returns the fused pending-animation flag (0 or 1) on success, or a NEGATIVE
   * status (`-WASM_STATUS.CAPACITY`, `-WASM_STATUS.UNINITIALIZED`) when the
   * kernel rejected the call and wrote nothing. Both 0 and 1 are meaningful
   * successes, so rejection cannot share their encoding.
   */
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
  pp_py(): number;
  pp_vx(): number;
  pp_vy(): number;
  pp_ox(): number;
  pp_oy(): number;
  pp_life(): number;
}

const PAD = 8;

/** Per-field SoA views over the kernel's linear memory. Position/velocity/life
 *  are read back each frame; origin is upload-once. */
export interface ParticleView {
  px: Float32Array;
  py: Float32Array;
  vx: Float32Array;
  vy: Float32Array;
  ox: Float32Array;
  oy: Float32Array;
  life: Float32Array;
}

/** Scalar simulation parameters + the current explosion impulse, passed to
 *  `particle_step`. Mirrors `updateCPU`'s arguments. */
export interface ParticleStepParams {
  dt: number;
  mouseX: number;
  mouseY: number;
  width: number;
  height: number;
  springK: number;
  damping: number;
  bounceDamping: number;
  maxVelocity: number;
  explosion: { x: number; y: number; force: number } | null;
}

export class ParticleBackend {
  private readonly ex: ParticleExports;
  private cap = 0;
  private view!: ParticleView;

  constructor(instance: WebAssembly.Instance) {
    this.ex = instance.exports as unknown as ParticleExports;
  }

  /** The resident SoA views, valid until the next capacity growth. */
  particleView(): ParticleView {
    return this.view;
  }

  /**
   * Size (and grow, if needed) capacity for `count` particles. Call BEFORE
   * writing into {@link particleView} — a growth detaches the previous views.
   */
  ensure(count: number): void {
    if (count + PAD <= this.cap) return;
    this.cap = count + PAD;
    this.ex.particle_init(this.cap);
    this.refreshViews();
  }

  /**
   * Re-create the typed-array views if another backend's allocation grew the
   * shared linear memory and detached them (see {@link viewsStale}). Call after
   * {@link ensure} and before {@link gather}/{@link scatter}.
   */
  public revalidateViews(): void {
    if (this.cap === 0) return;
    if (viewsStale(this.cap, this.view.px, this.ex.memory)) this.refreshViews();
  }

  /**
   * Advance `count` particles one step in place. Returns `true` when at least
   * one live particle is still moving or off-origin beyond epsilon (the fused
   * `hasPendingAnimations` flag), so the caller need not re-scan the buffer.
   *
   * Returns `null` when the kernel REJECTED the call — `count` beyond the
   * capacity {@link ensure} allocated, or no `particle_init` yet. Nothing was
   * written, so the caller must NOT {@link scatter} (that would write the
   * gathered pre-step values back and freeze the simulation) and should fall
   * back to the JS `updateCPU` path for this frame. See {@link lastStatus}.
   */
  step(count: number, p: ParticleStepParams): boolean | null {
    const e = p.explosion;
    const flag = this.ex.particle_step(
      p.dt,
      p.mouseX,
      p.mouseY,
      p.width,
      p.height,
      p.springK,
      p.damping,
      p.bounceDamping,
      p.maxVelocity,
      e ? 1 : 0,
      e ? e.x : 0,
      e ? e.y : 0,
      e ? e.force : 0,
      count,
    );
    // A negative return is a rejection status, not a pending flag; `flag !== 0`
    // would read it as "still animating" and hide the fault.
    if (flag < 0) {
      this.lastStatus = -flag;
      return null;
    }
    this.lastStatus = WASM_STATUS.OK;
    return flag !== 0;
  }

  /**
   * Status of the most recent {@link step} — `WASM_STATUS.OK` unless the kernel
   * declined it. Mirrors {@link TransformBackend.lastStatus}.
   */
  public lastStatus: number = WASM_STATUS.OK;

  /** Transpose the AoS stride-8 buffer into the SoA views (position/velocity/
   *  life every frame; origin upload-once when `withOrigin`). */
  gather(data: Float32Array, count: number, withOrigin: boolean): void {
    const v = this.view;
    for (let i = 0; i < count; i++) {
      const o = i * PARTICLE_STRIDE_FLOATS;
      v.px[i] = data[o + PARTICLE_OFFSET_POSITION_X];
      v.py[i] = data[o + PARTICLE_OFFSET_POSITION_Y];
      v.vx[i] = data[o + PARTICLE_OFFSET_VELOCITY_X];
      v.vy[i] = data[o + PARTICLE_OFFSET_VELOCITY_Y];
      v.life[i] = data[o + PARTICLE_OFFSET_LIFE];
      if (withOrigin) {
        v.ox[i] = data[o + PARTICLE_OFFSET_ORIGIN_X];
        v.oy[i] = data[o + PARTICLE_OFFSET_ORIGIN_Y];
      }
    }
  }

  /** Scatter the mutated position/velocity/life back into the AoS buffer. */
  scatter(data: Float32Array, count: number): void {
    const v = this.view;
    for (let i = 0; i < count; i++) {
      const o = i * PARTICLE_STRIDE_FLOATS;
      data[o + PARTICLE_OFFSET_POSITION_X] = v.px[i];
      data[o + PARTICLE_OFFSET_POSITION_Y] = v.py[i];
      data[o + PARTICLE_OFFSET_VELOCITY_X] = v.vx[i];
      data[o + PARTICLE_OFFSET_VELOCITY_Y] = v.vy[i];
      data[o + PARTICLE_OFFSET_LIFE] = v.life[i];
    }
  }

  private refreshViews(): void {
    const buf = this.ex.memory.buffer;
    const c = this.cap;
    this.view = {
      px: new Float32Array(buf, this.ex.pp_px(), c),
      py: new Float32Array(buf, this.ex.pp_py(), c),
      vx: new Float32Array(buf, this.ex.pp_vx(), c),
      vy: new Float32Array(buf, this.ex.pp_vy(), c),
      ox: new Float32Array(buf, this.ex.pp_ox(), c),
      oy: new Float32Array(buf, this.ex.pp_oy(), c),
      life: new Float32Array(buf, this.ex.pp_life(), c),
    };
  }
}

/** Instantiate synchronously (Node/tests/worker). Returns `null` on failure so
 *  callers fall back to the JS `updateCPU`. */
export function instantiateSync(bytes: BufferSource): ParticleBackend | null {
  try {
    const module = new WebAssembly.Module(bytes);
    const instance = new WebAssembly.Instance(module, {});
    return new ParticleBackend(instance);
  } catch {
    return null;
  }
}

/** Instantiate asynchronously (browser main thread). Returns `null` on any
 *  failure so the caller keeps using the JS `updateCPU`. */
export async function instantiateAsync(bytes: BufferSource): Promise<ParticleBackend | null> {
  try {
    const { instance } = await WebAssembly.instantiate(bytes, {});
    return new ParticleBackend(instance);
  } catch {
    return null;
  }
}

/** Anything the particle core can be loaded from. */
export type ParticleModuleSource = BufferSource | string | URL | Response | Promise<Response>;

/** Instantiate from a URL/Response with streaming compilation when available,
 *  falling back to fetch → arrayBuffer → instantiate. Returns `null` on any
 *  failure so the caller keeps the JS path. */
export async function instantiateStreaming(
  source: string | URL | Response | Promise<Response>,
): Promise<ParticleBackend | null> {
  try {
    const resp =
      typeof source === 'string' || source instanceof URL
        ? await fetch(String(source))
        : await source;
    if (typeof WebAssembly.instantiateStreaming === 'function') {
      const buffered = resp.clone();
      try {
        const { instance } = await WebAssembly.instantiateStreaming(resp, {});
        return new ParticleBackend(instance);
      } catch {
        const { instance } = await WebAssembly.instantiate(await buffered.arrayBuffer(), {});
        return new ParticleBackend(instance);
      }
    }
    const { instance } = await WebAssembly.instantiate(await resp.arrayBuffer(), {});
    return new ParticleBackend(instance);
  } catch {
    return null;
  }
}

const f = Math.fround;

/**
 * JS f32 reference for `particle_step`, operating on the same {@link ParticleView}
 * SoA arrays in place and returning the fused pending-animation flag. This is the
 * kernel's differential oracle: every intermediate is rounded to f32 with
 * `Math.fround` in the SAME op order as `particle.rs`, and distance uses
 * `sqrt(dx*dx+dy*dy)` (NOT `Math.hypot`). It is therefore bit-identical to the
 * Rust kernel — the differential test asserts exact equality. (This is NOT the
 * shipped fallback; `ComputeParticleEntity.updateCPU` stays f64.)
 */
export function particleStepReferenceF32(
  view: ParticleView,
  count: number,
  p: ParticleStepParams,
): boolean {
  const EPS_VELOCITY = 0.5;
  const EPS_DISTANCE = 0.5;
  const safeDt = isNaN(p.dt) ? f(0.016) : f(Math.max(0.0, Math.min(p.dt, 0.1)));
  const safeW = f(Math.max(1.0, p.width));
  const safeH = f(Math.max(1.0, p.height));
  const k = f(Math.max(0.0, Math.min(p.springK, 10.0)));
  const damp = f(Math.max(0.0, Math.min(p.damping, 1.0)));
  const bounce = f(Math.max(0.0, Math.min(p.bounceDamping, 1.0)));
  const maxV = f(Math.max(1.0, p.maxVelocity));
  const mouseOn = !isNaN(p.mouseX) && !isNaN(p.mouseY) && p.mouseX > -9000.0 && p.mouseY > -9000.0;
  const mouseX = f(p.mouseX);
  const mouseY = f(p.mouseY);
  const e = p.explosion;
  const explX = e ? f(e.x) : 0;
  const explY = e ? f(e.y) : 0;
  const explForce = e ? f(e.force) : 0;

  let pending = false;

  for (let i = 0; i < count; i++) {
    let px = view.px[i];
    let py = view.py[i];
    let vx = view.vx[i];
    let vy = view.vy[i];
    const ox = view.ox[i];
    const oy = view.oy[i];
    const life = view.life[i];

    if (isNaN(px)) px = ox;
    if (isNaN(py)) py = oy;
    if (isNaN(vx)) vx = 0.0;
    if (isNaN(vy)) vy = 0.0;

    const fxSpring = f(f(ox - px) * k);
    const fySpring = f(f(oy - py) * k);

    let fxMouse = 0;
    let fyMouse = 0;
    if (mouseOn) {
      const dx = f(mouseX - px);
      const dy = f(mouseY - py);
      const dist = f(Math.sqrt(f(f(dx * dx) + f(dy * dy))));
      if (dist < 120.0 && dist > 0.1) {
        const force = f(f(120.0 - dist) * 2.0);
        fxMouse = f(f(-f(dx / dist)) * force);
        fyMouse = f(f(-f(dy / dist)) * force);
      }
    }

    let fxExpl = 0;
    let fyExpl = 0;
    if (e) {
      const ex = f(explX - px);
      const ey = f(explY - py);
      const edist = f(Math.sqrt(f(f(ex * ex) + f(ey * ey))));
      if (edist < 150.0 && edist > 0.1) {
        const force = f(f(150.0 - edist) * explForce);
        fxExpl = f(f(-f(ex / edist)) * force);
        fyExpl = f(f(-f(ey / edist)) * force);
      }
    }

    const ax = f(f(fxSpring + fxMouse) + fxExpl);
    const ay = f(f(fySpring + fyMouse) + fyExpl);
    let nvx = f(f(vx + f(ax * safeDt)) * damp);
    let nvy = f(f(vy + f(ay * safeDt)) * damp);

    const speed = f(Math.sqrt(f(f(nvx * nvx) + f(nvy * nvy))));
    if (speed > maxV) {
      nvx = f(f(nvx / speed) * maxV);
      nvy = f(f(nvy / speed) * maxV);
    }

    let npx = f(px + f(nvx * safeDt));
    let npy = f(py + f(nvy * safeDt));

    if ((npx <= 0.0 && nvx < 0.0) || (npx >= safeW && nvx > 0.0)) {
      nvx = f(f(-nvx) * bounce);
    }
    if ((npy <= 0.0 && nvy < 0.0) || (npy >= safeH && nvy > 0.0)) {
      nvy = f(f(-nvy) * bounce);
    }

    npx = f(Math.max(0.0, Math.min(safeW, npx)));
    npy = f(Math.max(0.0, Math.min(safeH, npy)));

    let nlife = life;
    if (life >= 0.0) {
      nlife = f(Math.max(0.0, f(life - f(safeDt * 0.5))));
    }

    view.px[i] = npx;
    view.py[i] = npy;
    view.vx[i] = nvx;
    view.vy[i] = nvy;
    view.life[i] = nlife;

    if (nlife !== 0.0) {
      if (f(f(nvx * nvx) + f(nvy * nvy)) > EPS_VELOCITY * EPS_VELOCITY) {
        pending = true;
      } else {
        const ddx = f(npx - ox);
        const ddy = f(npy - oy);
        if (f(f(ddx * ddx) + f(ddy * ddy)) > EPS_DISTANCE * EPS_DISTANCE) {
          pending = true;
        }
      }
    }
  }

  return pending;
}
