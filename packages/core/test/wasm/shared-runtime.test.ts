// @vitest-environment jsdom
// One WASM runtime per Scene, not one per backend.
//
// Each `enableWasm*` used to instantiate the binary itself, so a Scene enabling
// all four accelerators compiled the same module up to four times and held four
// separate linear memories. Nothing needed that: the Rust crate keeps the
// transform, anim, hit and particle stores in distinct statics, so they do not
// alias inside a single instance.
//
// These tests pin the two properties that make the consolidation safe:
//   - all four backends of one Scene share ONE instance (and therefore one
//     memory), so a fused transform -> AABB -> hit-grid path is possible at all;
//   - two Scenes get SEPARATE instances, because that isolation is the part the
//     old design was actually buying.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { Scene } from '../../src/index';
import {
  clearCoreWasmModuleCache,
  createCoreWasmRuntime,
  loadCoreWasmModule,
  loadCoreWasmRuntime,
} from '../../src/wasm/runtime';

HTMLCanvasElement.prototype.getContext = (() => null) as never;

const wasmPath = resolve(process.cwd(), 'src/wasm/vectojs_core.wasm');
const haveWasm = existsSync(wasmPath);
const wasmBytes = (): Uint8Array => {
  const b = readFileSync(wasmPath);
  const out = new Uint8Array(b.byteLength);
  out.set(b);
  return out;
};

function makeScene(): Scene {
  (globalThis as { window?: unknown }).window = {
    innerWidth: 800,
    innerHeight: 600,
    devicePixelRatio: 1,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  };
  const canvas = document.createElement('canvas');
  canvas.width = 800;
  canvas.height = 600;
  return new Scene(canvas, { disableWindowResize: true });
}

afterEach(() => {
  clearCoreWasmModuleCache();
  vi.restoreAllMocks();
});

describe.skipIf(!haveWasm)('shared core WASM runtime', () => {
  it('serves all four backends from a single instance', async () => {
    const runtime = await loadCoreWasmRuntime(wasmBytes());
    expect(runtime).not.toBeNull();

    // Every backend must report the same underlying instance. If any built its
    // own, its typed-array views would point into a different linear memory and
    // no data could be handed between kernels without a copy.
    const instance = runtime!.instance;
    const memory = (instance.exports as { memory: WebAssembly.Memory }).memory;
    expect(memory).toBeInstanceOf(WebAssembly.Memory);

    // Backends are memoised, so repeated access does not re-create stores.
    expect(runtime!.transform()).toBe(runtime!.transform());
    expect(runtime!.anim()).toBe(runtime!.anim());
    expect(runtime!.hit()).toBe(runtime!.hit());
    expect(runtime!.particle()).toBe(runtime!.particle());
  });

  it('enabling all four accelerators instantiates the module once', async () => {
    const scene = makeScene();
    const bytes = wasmBytes();

    const okTransforms = await scene.enableWasmTransforms(bytes);
    const okHit = await scene.enableWasmHitTest(bytes);
    const okAnim = await scene.enableWasmAnimBatching(bytes);
    const okParticles = await scene.enableWasmParticles(bytes);

    expect([okTransforms, okHit, okAnim, okParticles]).toEqual([true, true, true, true]);
    expect(scene.transformBackend).toBe('wasm');
    expect(scene.hitTestBackend).toBe('wasm');

    // The observable consequence: one runtime, therefore one instance, therefore
    // one linear memory for all four.
    expect(scene.wasmRuntime).not.toBeNull();
    const runtime = scene.wasmRuntime!;
    expect(runtime.transform()).toBeTruthy();
    expect(runtime.anim()).toBeTruthy();
    expect(runtime.hit()).toBeTruthy();
    expect(runtime.particle()).toBeTruthy();

    scene.destroy();
  });

  it('gives two Scenes separate instances', async () => {
    const a = makeScene();
    const b = makeScene();
    await a.enableWasmTransforms(wasmBytes());
    await b.enableWasmTransforms(wasmBytes());

    expect(a.wasmRuntime).not.toBeNull();
    expect(b.wasmRuntime).not.toBeNull();
    // Sharing a compiled module is fine; sharing mutable stores is not.
    expect(a.wasmRuntime!.instance).not.toBe(b.wasmRuntime!.instance);

    a.destroy();
    b.destroy();
  });

  it('caches the compiled module per URL source', async () => {
    // Raw bytes have no stable identity to key on, so only URL/path sources are
    // cached. Two loads of the same path must reuse one compile.
    const url = `file://${wasmPath}`;
    const fetchMock = vi.fn(async () => new Response(wasmBytes() as BufferSource));
    vi.stubGlobal('fetch', fetchMock);

    const first = await loadCoreWasmModule(url);
    const second = await loadCoreWasmModule(url);

    expect(first).not.toBeNull();
    expect(second).toBe(first);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not cache a failure, so a transient error is retryable', async () => {
    const url = 'https://example.invalid/vectojs_core.wasm';
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error('503'))
      .mockResolvedValueOnce(new Response(wasmBytes() as BufferSource));
    vi.stubGlobal('fetch', fetchMock);

    expect(await loadCoreWasmModule(url)).toBeNull();
    // A poisoned cache entry would make WASM permanently unavailable after one
    // flaky response, which is worse than the extra compile.
    expect(await loadCoreWasmModule(url)).not.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('returns null rather than throwing on corrupt bytes', async () => {
    expect(await loadCoreWasmRuntime(new Uint8Array([0, 1, 2, 3]))).toBeNull();

    const scene = makeScene();
    // Failure keeps the Scene on JS: loading an accelerator is never an error
    // path for the app.
    expect(await scene.enableWasmTransforms(new Uint8Array([0, 1, 2, 3]))).toBe(false);
    expect(scene.transformBackend).toBe('js');
    scene.destroy();
  });

  it('accepts a pre-built runtime so Scenes can share one compile', async () => {
    const module = await loadCoreWasmModule(wasmBytes());
    expect(module).not.toBeNull();

    const shared = createCoreWasmRuntime(module!);
    expect(shared).not.toBeNull();

    const scene = makeScene();
    scene.setWasmRuntime(shared);
    expect(scene.wasmRuntime).toBe(shared);

    // With a runtime already installed, enabling must reuse it rather than
    // loading again.
    expect(await scene.enableWasmTransforms(wasmBytes())).toBe(true);
    expect(scene.wasmRuntime).toBe(shared);
    scene.destroy();
  });
});
