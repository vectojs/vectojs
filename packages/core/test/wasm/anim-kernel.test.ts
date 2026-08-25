// @vitest-environment node
// G2 spike — correctness of the batched animation kernels BEFORE trusting any
// benchmark number. Spring is BIT-IDENTICAL to @vectojs/math SpringPhysics
// (pure arithmetic); tween is now BIT-IDENTICAL to @vectojs/animation
// TweenDriver too — both sides express integer-power easings as explicit
// multiplication (no Math.pow/powi), so the old ~1e-9 ULP gap is closed.
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { SpringPhysics } from '@vectojs/math';
import { TweenDriver, type EasingName } from '@vectojs/animation';

const wasmPath = resolve(process.cwd(), 'src/wasm/vectojs_core.wasm');
const haveWasm = existsSync(wasmPath);

interface AnimExports {
  memory: WebAssembly.Memory;
  anim_init(springCap: number, tweenCap: number): void;
  spring_step(dt: number, count: number): void;
  /** Status code: 0 = ok, non-zero = rejected (see WASM_STATUS). */
  tween_step(dt: number, count: number): number;
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

function instantiate(
  springCap: number,
  tweenCap: number,
): { ex: AnimExports; view: (p: number, n: number) => Float64Array } {
  const module = new WebAssembly.Module(readFileSync(wasmPath));
  const instance = new WebAssembly.Instance(module, {});
  const ex = instance.exports as unknown as AnimExports;
  ex.anim_init(springCap, tweenCap); // allocates (may grow memory) — view AFTER
  const cap = Math.max(springCap, tweenCap) + 8;
  const view = (p: number, _n: number): Float64Array => new Float64Array(ex.memory.buffer, p, cap);
  return { ex, view };
}

// Deterministic PRNG so a failure reproduces.
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0), s / 0x100000000);
}

const EASINGS: EasingName[] = [
  'linear',
  'easeInQuad',
  'easeOutQuad',
  'easeInOutQuad',
  'easeInCubic',
  'easeOutCubic',
  'easeInOutCubic',
  'easeOutBack',
  'easeInOutBack',
];

describe.skipIf(!haveWasm)('G2 spike — animation kernels', () => {
  it('spring_step is bit-identical to SpringPhysics over many frames', () => {
    const N = 200;
    const { ex, view } = instantiate(N, 1);
    const sVal = view(ex.p_s_val(), N);
    const sTarget = view(ex.p_s_target(), N);
    const sVel = view(ex.p_s_vel(), N);
    const sStiff = view(ex.p_s_stiff(), N);
    const sDamp = view(ex.p_s_damp(), N);
    const sMass = view(ex.p_s_mass(), N);

    const rand = rng(0xc0ffee);
    const js: SpringPhysics[] = [];
    for (let i = 0; i < N; i++) {
      const from = (rand() - 0.5) * 200;
      const to = (rand() - 0.5) * 200;
      const stiffness = 80 + rand() * 300;
      const damping = 5 + rand() * 25;
      const mass = 0.5 + rand() * 2;
      sVal[i] = from;
      sTarget[i] = to;
      sVel[i] = 0;
      sStiff[i] = stiffness;
      sDamp[i] = damping;
      sMass[i] = mass;
      const sp = new SpringPhysics(from);
      sp.stiffness = stiffness;
      sp.damping = damping;
      sp.mass = mass;
      sp.target = to;
      js.push(sp);
    }

    const dtSec = 1 / 60;
    for (let frame = 0; frame < 40; frame++) {
      ex.spring_step(dtSec, N);
      for (let i = 0; i < N; i++) js[i].update(dtSec);
      for (let i = 0; i < N; i++) {
        expect(sVal[i]).toBe(js[i].value);
        expect(sVel[i]).toBe(js[i].velocity);
      }
    }
  });

  it('tween_step matches TweenDriver bit-for-bit (explicit-multiply easings)', () => {
    const N = EASINGS.length * 20;
    const { ex, view } = instantiate(1, N);
    const tFrom = view(ex.p_t_from(), N);
    const tTo = view(ex.p_t_to(), N);
    const tElapsed = view(ex.p_t_elapsed(), N);
    const tDur = view(ex.p_t_dur(), N);
    const tDelay = view(ex.p_t_delay(), N);
    const tEase = view(ex.p_t_ease(), N);
    const tVal = view(ex.p_t_val(), N);

    const rand = rng(0x1234);
    const js: TweenDriver[] = [];
    for (let i = 0; i < N; i++) {
      const from = (rand() - 0.5) * 100;
      const to = (rand() - 0.5) * 100;
      const duration = 200 + rand() * 800;
      const delay = rand() * 100;
      const easingId = i % EASINGS.length;
      tFrom[i] = from;
      tTo[i] = to;
      tElapsed[i] = 0;
      tDur[i] = duration;
      tDelay[i] = delay;
      tEase[i] = easingId;
      tVal[i] = from; // TweenDriver seeds value = from
      js.push(
        new TweenDriver(from, to, {
          duration,
          delay,
          easing: EASINGS[easingId],
        }),
      );
    }

    const dtMs = 1000 / 60;
    for (let frame = 0; frame < 40; frame++) {
      ex.tween_step(dtMs, N);
      for (let i = 0; i < N; i++) js[i].tick(dtMs);
      for (let i = 0; i < N; i++) {
        // Bit-for-bit: both sides now express integer-power easings as explicit
        // multiplication, so there is no ULP gap left to tolerate.
        expect(tVal[i]).toBe(js[i].value);
      }
    }
  });

  it('tween_step snaps completed tweens exactly onto `to` for magnitude-spread pairs (#647)', () => {
    // TweenDriver.tick ends with `if (active >= this.duration) this.value =
    // this.to;` — outside Sterbenz range, `from + (to - from)` rounds short of
    // `to` (e.g. from=1e20, to=7 computes 1e20 + (7 - 1e20) === 0), so the
    // kernel must mirror the snap or WASM tweens end off-destination while the
    // JS reference lands exactly. The fixed-seed (-50,50) suite above cannot
    // see this: there the identity holds by rounding luck.
    const spreadPairs: Array<[number, number]> = [
      [1e20, 7], // diff loses `to` entirely; naive sum is 0
      [7, 1e20],
      [1e16, 5],
      [-1e300, 1e-300],
      [1e-300, 1e300],
      [Number.MIN_VALUE, Number.MAX_VALUE],
      [123456789.5, 123456789.75], // near-equal, 2 ulp apart
      [0, 5e-324], // denormal target
    ];
    // Random pairs across independent exponent scales — many land outside
    // Sterbenz range and diverge without the snap.
    const rand = rng(0x647);
    for (let i = 0; i < 40; i++) {
      const mag = (s: number) => (s - 0.5 > 0 ? 1 : -1) * Math.pow(10, (s - 0.5) * 320);
      spreadPairs.push([mag(rand()), mag(rand())]);
    }

    const N = spreadPairs.length;
    const { ex, view } = instantiate(1, N);
    const tFrom = view(ex.p_t_from(), N);
    const tTo = view(ex.p_t_to(), N);
    const tElapsed = view(ex.p_t_elapsed(), N);
    const tDur = view(ex.p_t_dur(), N);
    const tDelay = view(ex.p_t_delay(), N);
    const tEase = view(ex.p_t_ease(), N);
    const tVal = view(ex.p_t_val(), N);

    const js: TweenDriver[] = [];
    for (let i = 0; i < N; i++) {
      const [from, to] = spreadPairs[i];
      const duration = 100;
      tFrom[i] = from;
      tTo[i] = to;
      tElapsed[i] = 0;
      tDur[i] = duration;
      tDelay[i] = 0;
      tEase[i] = 0; // linear
      tVal[i] = from;
      js.push(new TweenDriver(from, to, { duration, easing: 'linear' }));
    }

    const dtMs = 1000 / 60;
    // 40 frames ≈ 666ms >> duration: every tween completes early and the
    // remaining frames verify the snap persists on both engines bit-for-bit.
    let doneFrames = 0;
    for (let frame = 0; frame < 40; frame++) {
      ex.tween_step(dtMs, N);
      for (let i = 0; i < N; i++) js[i].tick(dtMs);
      if (js[0].isDone()) doneFrames++;
      for (let i = 0; i < N; i++) {
        expect(tVal[i]).toBe(js[i].value); // bit-for-bit, Object.is semantics
        if (js[i].isDone()) expect(tVal[i]).toBe(tTo[i]); // terminal invariant
      }
    }
    expect(doneFrames).toBeGreaterThan(0);
  });

  it('tween_step declines NaN/0/negative dt exactly like TweenDriver.tick (#784)', () => {
    // One bad dt used to write t_elapsed = NaN through with STATUS_OK,
    // poisoning every later frame in the WASM path while pure-JS mode ignored
    // the same step; a negative dt additionally rewound finished tweens. Both
    // engines must decline identically: state preserved, then recovery on the
    // next valid frame.
    const N = 8;
    const { ex, view } = instantiate(1, N);
    const tFrom = view(ex.p_t_from(), N);
    const tTo = view(ex.p_t_to(), N);
    const tElapsed = view(ex.p_t_elapsed(), N);
    const tDur = view(ex.p_t_dur(), N);
    const tDelay = view(ex.p_t_delay(), N);
    const tEase = view(ex.p_t_ease(), N);
    const tVal = view(ex.p_t_val(), N);

    for (let i = 0; i < N; i++) {
      tFrom[i] = 0;
      tTo[i] = 100;
      tElapsed[i] = 0;
      tDur[i] = 1000;
      tDelay[i] = 0;
      tEase[i] = 0; // linear
      tVal[i] = 0;
    }

    // Establish prior state on both engines.
    ex.tween_step(160, N);
    const jsDrivers: TweenDriver[] = [];
    for (let i = 0; i < N; i++)
      jsDrivers.push(new TweenDriver(0, 100, { duration: 1000, easing: 'linear' }));
    for (let i = 0; i < N; i++) jsDrivers[i].tick(160);

    for (const badDt of [Number.NaN, 0, -16, -Number.POSITIVE_INFINITY]) {
      const elapsedBefore = Array.from(tElapsed.subarray(0, N));
      const valBefore = Array.from(tVal.subarray(0, N));
      const jsBefore = jsDrivers.map((d) => [d.value, d.elapsedMs]);

      expect(ex.tween_step(badDt, N)).toBe(0); // STATUS_OK — declined, not an error
      for (let i = 0; i < N; i++) jsDrivers[i].tick(badDt);

      for (let i = 0; i < N; i++) {
        expect(tElapsed[i]).toBe(elapsedBefore[i]); // kernel state untouched
        expect(tVal[i]).toBe(valBefore[i]);
        expect(jsDrivers[i].value).toBe(jsBefore[i][0]); // JS parity
        expect(jsDrivers[i].elapsedMs).toBe(jsBefore[i][1]);
        expect(tElapsed[i]).toBe(jsDrivers[i].elapsedMs); // engines agree
      }
    }

    // The next VALID frame advances both engines identically — no poisoning.
    ex.tween_step(160, N);
    for (let i = 0; i < N; i++) jsDrivers[i].tick(160);
    for (let i = 0; i < N; i++) {
      expect(tElapsed[i]).toBe(jsDrivers[i].elapsedMs);
      expect(tElapsed[i]).toBe(320);
      expect(tVal[i]).toBe(jsDrivers[i].value);
    }
  });

  it('spring_step snaps a rested spring exactly to target', () => {
    const { ex, view } = instantiate(1, 1);
    const sVal = view(ex.p_s_val(), 1);
    const sTarget = view(ex.p_s_target(), 1);
    const sVel = view(ex.p_s_vel(), 1);
    const sStiff = view(ex.p_s_stiff(), 1);
    const sDamp = view(ex.p_s_damp(), 1);
    const sMass = view(ex.p_s_mass(), 1);
    sVal[0] = 100.0001; // within rest epsilon of target
    sTarget[0] = 100;
    sVel[0] = 0.0001;
    sStiff[0] = 180;
    sDamp[0] = 12;
    sMass[0] = 1;
    ex.spring_step(1 / 60, 1);
    expect(sVal[0]).toBe(100);
    expect(sVel[0]).toBe(0);
  });
});
