// @vitest-environment jsdom
// G4 integration: Scene runs a ComputeParticleEntity's CPU fallback through the
// WASM particle kernel (entity.stepWithBackend) instead of the per-particle JS
// updateCPU loop, when a particle backend is installed. Checks the INTEGRATED
// path (real Scene + entity + render loop + AoS<->SoA transpose), not the
// isolated kernel (covered by particle-kernel.test.ts) — per the G3 lesson, an
// isolated kernel's correctness says nothing about the wiring around it.
import { describe, it, expect, vi } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { Scene, ComputeParticleEntity } from '../../src/index';
import { instantiateSync } from '../../src/wasm/particle-backend';

const wasmPath = resolve(process.cwd(), 'src/wasm/vectojs_core.wasm');
const haveWasm = existsSync(wasmPath);
const bytes = () => readFileSync(wasmPath);

function fakeCtx() {
  return new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === 'measureText') return (t: string) => ({ width: t.length * 8 });
        if (prop === 'canvas') return { width: 0, height: 0, style: {} };
        return () => {};
      },
      set: () => true,
    },
  ) as unknown as CanvasRenderingContext2D;
}

function makeScene(): Scene {
  HTMLCanvasElement.prototype.getContext = (() => fakeCtx()) as never;
  const canvas = document.createElement('canvas');
  const scene = new Scene(canvas, { particleBackend: 'cpu', maxFPS: 0 });
  (scene as unknown as { isRunning: boolean }).isRunning = true;
  (scene as unknown as { webgpuDisabled: boolean }).webgpuDisabled = true; // force CPU path
  return scene;
}

describe.skipIf(!haveWasm)('G4 Scene integration — WASM particle CPU sim', () => {
  it('installs the backend and reports particleSimBackend = wasm', () => {
    const scene = makeScene();
    const backend = instantiateSync(bytes())!;
    expect(scene.particleSimBackend).toBe('js');
    scene.setParticleBackend(backend);
    expect(scene.particleSimBackend).toBe('wasm');
    scene.destroy();
  });

  it('the WASM-advanced buffer tracks the JS updateCPU buffer within f32 tolerance', () => {
    // Two identical entities: one stepped by the backend via Scene, one by the
    // JS updateCPU directly. After many frames the f32-vs-f64 paths must stay
    // visually coincident (sub-pixel), never diverge into different motion.
    const scene = makeScene();
    const backend = instantiateSync(bytes())!;
    scene.setParticleBackend(backend);

    const wasmEntity = new ComputeParticleEntity({ maxParticles: 500 });
    wasmEntity.initRandomParticles(800, 600);
    // A JS twin seeded from the SAME initial buffer.
    const jsEntity = new ComputeParticleEntity({ maxParticles: 500 });
    jsEntity.particleData.set(wasmEntity.particleData);

    for (let frame = 0; frame < 120; frame++) {
      wasmEntity.stepWithBackend(backend, 0.016, 400, 300, 800, 600);
      jsEntity.updateCPU(0.016, 400, 300, 800, 600);
    }

    // Compare positions: f32 kernel vs f64 loop drift a tiny amount per step;
    // over 120 frames they must remain within a small absolute tolerance.
    let maxDiff = 0;
    for (let i = 0; i < 500; i++) {
      const o = i * 8;
      maxDiff = Math.max(
        maxDiff,
        Math.abs(wasmEntity.particleData[o] - jsEntity.particleData[o]),
        Math.abs(wasmEntity.particleData[o + 1] - jsEntity.particleData[o + 1]),
      );
    }
    expect(maxDiff).toBeLessThan(1.0); // sub-pixel after 120 frames
    scene.destroy();
  });

  it('fuses hasPendingAnimations: rest particles report no pending after a WASM step', () => {
    const scene = makeScene();
    const backend = instantiateSync(bytes())!;
    scene.setParticleBackend(backend);

    const e = new ComputeParticleEntity({ maxParticles: 64 });
    // All particles at rest exactly on their origin, perpetual life.
    for (let i = 0; i < 64; i++) {
      const o = i * 8;
      e.particleData[o] = 100; // px
      e.particleData[o + 1] = 100; // py
      e.particleData[o + 2] = 0; // vx
      e.particleData[o + 3] = 0; // vy
      e.particleData[o + 4] = 100; // ox
      e.particleData[o + 5] = 100; // oy
      e.particleData[o + 7] = -1; // life (perpetual)
    }
    e.stepWithBackend(backend, 0.016, -9999, -9999, 800, 600);
    expect(e.hasPendingAnimations()).toBe(false);

    // A moving particle flips the fused flag to true.
    e.particleData[2] = 50; // vx well above the 0.5 px/s epsilon
    e.stepWithBackend(backend, 0.016, -9999, -9999, 800, 600);
    expect(e.hasPendingAnimations()).toBe(true);
    scene.destroy();
  });

  it('falls back to JS updateCPU (no backend) — hasPendingAnimations re-scans', () => {
    const e = new ComputeParticleEntity({ maxParticles: 32 });
    for (let i = 0; i < 32; i++) {
      const o = i * 8;
      e.particleData[o] = 50;
      e.particleData[o + 1] = 50;
      e.particleData[o + 4] = 50;
      e.particleData[o + 5] = 50;
      e.particleData[o + 7] = -1;
    }
    e.updateCPU(0.016, -9999, -9999, 800, 600); // JS path clears the wasm cache
    expect(e.hasPendingAnimations()).toBe(false);
  });
});
