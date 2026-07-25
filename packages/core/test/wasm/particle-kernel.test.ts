import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  instantiateSync,
  particleStepReferenceF32,
  type ParticleBackend,
  type ParticleView,
  type ParticleStepParams,
} from '../../src/wasm/particle-backend';

// Built by crates/vectojs-core-rs/build.sh, gitignored (built in CI). Skipped
// (not failed) when absent — the JS updateCPU path is the permanent fallback.
const wasmPath = fileURLToPath(new URL('../../src/wasm/vectojs_core.wasm', import.meta.url));
const haveWasm = existsSync(wasmPath);

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

const f = Math.fround;

/** A plain-array ParticleView (the JS-reference oracle side of the compare). */
function makeRefView(count: number): ParticleView {
  return {
    px: new Float32Array(count),
    py: new Float32Array(count),
    vx: new Float32Array(count),
    vy: new Float32Array(count),
    ox: new Float32Array(count),
    oy: new Float32Array(count),
    life: new Float32Array(count),
  };
}

/** Seed both a WASM backend view and a reference view with identical f32 state. */
function seed(count: number, rand: () => number, ref: ParticleView, wasm: ParticleView): void {
  for (let i = 0; i < count; i++) {
    const px = f((rand() - 0.5) * 1600);
    const py = f((rand() - 0.5) * 1200);
    const vx = f((rand() - 0.5) * 400);
    const vy = f((rand() - 0.5) * 400);
    const ox = f((rand() - 0.5) * 1600);
    const oy = f((rand() - 0.5) * 1200);
    // Mix perpetual (-1), decaying (>0), and a few already-dead (0) particles.
    const r = rand();
    const life = r < 0.7 ? -1 : r < 0.95 ? f(rand() * 3) : 0;
    ref.px[i] = px;
    ref.py[i] = py;
    ref.vx[i] = vx;
    ref.vy[i] = vy;
    ref.ox[i] = ox;
    ref.oy[i] = oy;
    ref.life[i] = life;
    wasm.px[i] = px;
    wasm.py[i] = py;
    wasm.vx[i] = vx;
    wasm.vy[i] = vy;
    wasm.ox[i] = ox;
    wasm.oy[i] = oy;
    wasm.life[i] = life;
  }
}

/**
 * Compare two views field-by-field with a tight plain loop (Object.is, so it
 * distinguishes +0/-0 and treats NaN===NaN), calling `expect` only when a
 * mismatch is found — a per-value `expect().toBe()` over 2000×5 fields × 60
 * steps is ~600k assertions and times out in CI purely from matcher overhead.
 * Returns a describing string on first mismatch, or null when bit-identical.
 */
function firstMismatch(a: ParticleView, b: ParticleView, count: number): string | null {
  for (let i = 0; i < count; i++) {
    for (const field of ['px', 'py', 'vx', 'vy', 'life'] as const) {
      const av = a[field][i];
      const bv = b[field][i];
      if (!Object.is(av, bv)) {
        return `${field}[${i}]: ref=${av} wasm=${bv}`;
      }
    }
  }
  return null;
}

describe.skipIf(!haveWasm)('G4 particle kernel — WASM vs JS f32 reference (differential)', () => {
  const bytes = haveWasm ? readFileSync(wasmPath) : new Uint8Array();

  const scenarios: Array<{ name: string; params: () => ParticleStepParams }> = [
    {
      name: 'spring-only (no mouse, no explosion)',
      params: () => ({
        dt: 0.016,
        mouseX: -9999,
        mouseY: -9999,
        width: 1600,
        height: 1200,
        springK: 0.05,
        damping: 0.95,
        bounceDamping: 0.5,
        maxVelocity: 500,
        explosion: null,
      }),
    },
    {
      name: 'mouse repulsion active',
      params: () => ({
        dt: 0.016,
        mouseX: 400,
        mouseY: 300,
        width: 1600,
        height: 1200,
        springK: 0.08,
        damping: 0.9,
        bounceDamping: 0.6,
        maxVelocity: 400,
        explosion: null,
      }),
    },
    {
      name: 'explosion impulse',
      params: () => ({
        dt: 0.02,
        mouseX: -9999,
        mouseY: -9999,
        width: 1600,
        height: 1200,
        springK: 0.05,
        damping: 0.92,
        bounceDamping: 0.7,
        maxVelocity: 600,
        explosion: { x: 500, y: 400, force: 3 },
      }),
    },
    {
      name: 'clamped params (out-of-range dt/spring/damping)',
      params: () => ({
        dt: 5, // clamps to 0.1
        mouseX: 200,
        mouseY: 200,
        width: 0.2, // clamps to 1
        height: -3, // clamps to 1
        springK: 50, // clamps to 10
        damping: 2, // clamps to 1
        bounceDamping: -1, // clamps to 0
        maxVelocity: 0.1, // clamps to 1
        explosion: { x: 100, y: 100, force: 5 },
      }),
    },
  ];

  for (const sc of scenarios) {
    it(`stays bit-identical over 60 steps: ${sc.name}`, () => {
      const backend = instantiateSync(bytes) as ParticleBackend;
      expect(backend).not.toBeNull();
      const count = 1000;
      backend.ensure(count);
      const wasmView = backend.particleView();
      const refView = makeRefView(count + 8);
      const rand = rng(0x51ed);
      seed(count, rand, refView, wasmView);

      for (let step = 0; step < 60; step++) {
        // Explosion is a one-shot impulse (only the first step in updateCPU).
        const params = sc.params();
        if (step > 0) params.explosion = null;
        const wasmPending = backend.step(count, params);
        const refPending = particleStepReferenceF32(refView, count, params);
        expect(wasmPending).toBe(refPending);
        const mismatch = firstMismatch(refView, wasmView, count);
        expect(mismatch, `step ${step}: ${mismatch}`).toBeNull();
      }
    });
  }

  it('reports pending=false once every live particle rests at its origin', () => {
    const backend = instantiateSync(bytes) as ParticleBackend;
    const count = 16;
    backend.ensure(count);
    const v = backend.particleView();
    for (let i = 0; i < count; i++) {
      v.px[i] = 100;
      v.py[i] = 100;
      v.ox[i] = 100;
      v.oy[i] = 100;
      v.vx[i] = 0;
      v.vy[i] = 0;
      v.life[i] = -1; // perpetual, at rest at origin
    }
    const params: ParticleStepParams = {
      dt: 0.016,
      mouseX: -9999,
      mouseY: -9999,
      width: 800,
      height: 600,
      springK: 0.05,
      damping: 0.95,
      bounceDamping: 0.5,
      maxVelocity: 500,
      explosion: null,
    };
    expect(backend.step(count, params)).toBe(false);
  });
});
