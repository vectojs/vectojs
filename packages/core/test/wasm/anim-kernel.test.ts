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
