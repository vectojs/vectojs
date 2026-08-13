// @vitest-environment node
// P1 fix (vectojs#464): every backend of a Scene shares one WebAssembly.Instance
// and therefore one linear memory, so ANY backend's `*_init` can grow the memory
// and detach the typed-array views every other backend built over the old
// buffer. `revalidateViews()` must rebuild them; without it the anim/hit/particle
// backends read/write detached views silently — NaN spring/tween state, stale hit
// grids, and frozen particles.
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { AnimBackend } from '../../src/wasm/anim-backend';
import { HitTestBackend } from '../../src/wasm/hit-backend';
import { ParticleBackend } from '../../src/wasm/particle-backend';

const wasmPath = fileURLToPath(new URL('../../src/wasm/vectojs_core.wasm', import.meta.url));
const haveWasm = existsSync(wasmPath);

function sharedInstance(): {
  anim: AnimBackend;
  hit: HitTestBackend;
  particle: ParticleBackend;
  memory: WebAssembly.Memory;
} {
  const module = new WebAssembly.Module(readFileSync(wasmPath));
  const instance = new WebAssembly.Instance(module, {});
  return {
    anim: new AnimBackend(instance),
    hit: new HitTestBackend(instance),
    particle: new ParticleBackend(instance),
    memory: instance.exports.memory as WebAssembly.Memory,
  };
}

describe.skipIf(!haveWasm)('backend view revalidation after shared-memory growth', () => {
  it('anim/hit/particle views are detached by a growth and rebuilt by revalidateViews()', () => {
    const { anim, hit, particle, memory } = sharedInstance();
    anim.ensure(10, 10);
    hit.ensure(10, 100, 100, 64);
    particle.ensure(10);

    const animVal = anim.springView().val;
    const hitMinx = hit.inputView().minx;
    const particlePx = particle.particleView().px;
    expect(animVal.length).toBeGreaterThan(0);
    expect(hitMinx.length).toBeGreaterThan(0);
    expect(particlePx.length).toBeGreaterThan(0);

    // Grow the shared memory — exactly what another backend's `*_init` does.
    memory.grow(1);

    // All three views are now detached (length 0): reads return undefined and
    // writes silently no-op against the old buffer.
    expect(animVal.length).toBe(0);
    expect(hitMinx.length).toBe(0);
    expect(particlePx.length).toBe(0);

    anim.revalidateViews();
    hit.revalidateViews();
    particle.revalidateViews();

    expect(anim.springView().val.length).toBeGreaterThan(0);
    expect(anim.springView().val.buffer).toBe(memory.buffer);
    expect(hit.inputView().minx.buffer).toBe(memory.buffer);
    expect(particle.particleView().px.buffer).toBe(memory.buffer);
  });
});
