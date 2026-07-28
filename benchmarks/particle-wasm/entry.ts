// G4 real-hardware benchmark: particle CPU step, JS f64 `updateCPU` vs the WASM
// f32 kernel (`particle_step` via ParticleBackend), swept over particle count.
// This is the number that decides whether G4 integrates — the CPU particle path
// is the GPU-less fallback, and the loop is memory-bound (7 f32 in + 5 f32 out
// per particle), so a win is NOT assumed. Posts JSON to /results
// (hyprland-browser-bench contract). Both paths run the identical simulation;
// the WASM side additionally pays a per-frame AoS<->SoA gather/scatter, which is
// included in its timing on purpose (that is the real integration cost).
import { ComputeParticleEntity } from '@vectojs/core';
import {
  ParticleBackend,
  type ParticleStepParams,
} from '../../packages/core/src/wasm/particle-backend';
import { awaitStart, reportFailure, reportResult } from '../_shared/client.ts';
import { median } from '../_shared/stats.ts';

const p = new URLSearchParams(location.search);
const COUNTS = (p.get('counts') ?? '1000,10000,50000,100000').split(',').map(Number);
const FRAMES = Number(p.get('frames') ?? 200);
const TRIALS = Number(p.get('trials') ?? 10);
const W = 1600;
const H = 1200;

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0), s / 0x100000000);
}

function makeEntity(count: number): ComputeParticleEntity {
  const e = new ComputeParticleEntity({ maxParticles: count });
  e.initRandomParticles(W, H);
  return e;
}

// A representative frame: mouse active (exercises the repulsion branch on the
// particles near it), no explosion (a one-shot, not a steady per-frame cost).
function frameParams(): ParticleStepParams {
  return {
    dt: 0.016,
    mouseX: W / 2,
    mouseY: H / 2,
    width: W,
    height: H,
    springK: 0.05,
    damping: 0.95,
    bounceDamping: 0.5,
    maxVelocity: 500,
    explosion: null,
  };
}

/** JS f64 path: the shipped updateCPU loop, one call per frame. */
function benchJS(count: number): number {
  const ts: number[] = [];
  for (let t = 0; t < TRIALS; t++) {
    const e = makeEntity(count);
    const t0 = performance.now();
    for (let fr = 0; fr < FRAMES; fr++) e.updateCPU(0.016, W / 2, H / 2, W, H);
    ts.push(performance.now() - t0);
  }
  return median(ts) / FRAMES; // ms per frame
}

/** WASM f32 path: gather AoS->SoA (origin once), step in wasm, scatter back. */
function benchWasm(count: number, backend: ParticleBackend): number {
  const ts: number[] = [];
  for (let t = 0; t < TRIALS; t++) {
    const e = makeEntity(count);
    backend.ensure(count);
    backend.gather(e.particleData, count, true); // origin upload once
    const params = frameParams();
    const t0 = performance.now();
    for (let fr = 0; fr < FRAMES; fr++) {
      backend.gather(e.particleData, count, false); // pos/vel/life each frame
      backend.step(count, params);
      backend.scatter(e.particleData, count);
    }
    ts.push(performance.now() - t0);
  }
  return median(ts) / FRAMES;
}

async function main() {
  await awaitStart();
  const startedAt = performance.now();
  let backend: ParticleBackend | null = null;
  try {
    const bytes = await (await fetch('./vectojs_core.wasm')).arrayBuffer();
    const { instance } = await WebAssembly.instantiate(bytes, {});
    backend = new ParticleBackend(instance);
  } catch {
    backend = null;
  }

  const rows: any[] = [];
  for (const n of COUNTS) {
    // Reseed the entity RNG identically per count so both paths see the same
    // initial distribution (makeEntity uses initRandomParticles internally).
    void rng; // (kept for parity with other benches; entity seeds itself)
    const jsMs = benchJS(n);
    const wasmMs = backend ? benchWasm(n, backend) : NaN;
    rows.push({
      particles: n,
      jsF64MsPerFrame: +jsMs.toFixed(4),
      wasmF32MsPerFrame: +wasmMs.toFixed(4),
      speedup: backend ? +(jsMs / wasmMs).toFixed(2) : null,
    });
  }

  // `params` keeps its existing contents verbatim. `haveWasm` is a wasm-availability
  // fact rather than a workload dimension, so it moves to `summary`. `engine` and
  // `userAgent` are dropped: the envelope supplies both. The try/catch around the
  // POST is gone because `reportResult` never throws — it swallows a failed POST
  // internally so the page always reaches the code after it.
  const report = await reportResult({
    name: 'particle-wasm',
    params: { COUNTS, FRAMES, TRIALS, W, H },
    summary: { haveWasm: !!backend },
    rows,
    durationMs: +(performance.now() - startedAt).toFixed(1),
    // Without the backend every wasm column is NaN, so the JS-vs-wasm comparison
    // this benchmark exists to make did not happen.
    issues: backend ? [] : ['wasm backend unavailable: wasmF32MsPerFrame is NaN'],
  });
  const pre = document.createElement('pre');
  pre.textContent = JSON.stringify(report, null, 2);
  document.body.appendChild(pre);
}

main().catch((error) => {
  // This entry had no failure path at all: a throw left the page open with no
  // POST, which the runner can only resolve by timing out. `reportFailure` posts
  // a complete `failed: true` envelope instead.
  void reportFailure('particle-wasm', error);
});
