// @vitest-environment jsdom
// enableWasmTransforms ergonomics: the transform core can be loaded from raw
// bytes, a URL/path string, or a Response — the shapes a bundler and a fetch()
// naturally produce — with streaming compilation and a buffered fallback for a
// wrong MIME type. Every failure path returns null / false so the Scene stays on
// the JS path (loading the accelerator is never an error path).
import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { Scene, Entity } from '../../src/index';
import { instantiateStreaming } from '../../src/wasm/backend';

HTMLCanvasElement.prototype.getContext = (() => null) as never;

const wasmPath = resolve(process.cwd(), 'src/wasm/vectojs_core.wasm');
const haveWasm = existsSync(wasmPath);
// A fresh ArrayBuffer-backed copy (not the Buffer's SharedArrayBuffer-typed
// view) so it satisfies BodyInit / BufferSource under TS's strict typed arrays.
const wasmBytes = () => {
  const b = readFileSync(wasmPath);
  const out = new Uint8Array(b.byteLength);
  out.set(b);
  return out;
};

function sceneWith(): Scene {
  (globalThis as { window?: unknown }).window = {
    innerWidth: 800,
    innerHeight: 600,
    devicePixelRatio: 1,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  };
  const canvas = {
    getContext: () => null,
    width: 400,
    height: 300,
    style: { width: '', height: '' },
  };
  return new Scene(canvas as never);
}

const origFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = origFetch;
  vi.restoreAllMocks();
});

class Box extends Entity {
  isPointInside(): boolean {
    return false;
  }
  render(): void {}
}

describe.skipIf(!haveWasm)('WASM loader ergonomics', () => {
  it('instantiates from a Response with the correct wasm MIME type', async () => {
    const resp = new Response(wasmBytes(), { headers: { 'content-type': 'application/wasm' } });
    const backend = await instantiateStreaming(resp);
    expect(backend).not.toBeNull();
  });

  it('falls back to buffered instantiate on a wrong MIME type', async () => {
    // A dev server serving octet-stream makes instantiateStreaming reject; the
    // buffered clone must still succeed.
    const resp = new Response(wasmBytes(), {
      headers: { 'content-type': 'application/octet-stream' },
    });
    const backend = await instantiateStreaming(resp);
    expect(backend).not.toBeNull();
  });

  it('fetches from a URL string', async () => {
    globalThis.fetch = vi.fn(
      async () => new Response(wasmBytes(), { headers: { 'content-type': 'application/wasm' } }),
    ) as typeof fetch;
    const backend = await instantiateStreaming('/assets/vectojs_core.wasm');
    expect(backend).not.toBeNull();
    expect(globalThis.fetch).toHaveBeenCalledWith('/assets/vectojs_core.wasm');
  });

  it('returns null when the fetch fails (e.g. 404 / network error)', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error('network down');
    }) as typeof fetch;
    const backend = await instantiateStreaming('/missing.wasm');
    expect(backend).toBeNull();
  });

  it('returns null on non-wasm bytes', async () => {
    const resp = new Response(new Uint8Array([0, 1, 2, 3]), {
      headers: { 'content-type': 'application/wasm' },
    });
    expect(await instantiateStreaming(resp)).toBeNull();
  });

  it('enableWasmTransforms accepts a Response and hot-swaps', async () => {
    const scene = sceneWith();
    scene.add(new Box('a'));
    const ok = await scene.enableWasmTransforms(
      new Response(wasmBytes(), { headers: { 'content-type': 'application/wasm' } }),
    );
    expect(ok).toBe(true);
    expect(scene.transformBackend).toBe('wasm');
  });

  it('enableWasmTransforms accepts a URL and hot-swaps', async () => {
    globalThis.fetch = vi.fn(
      async () => new Response(wasmBytes(), { headers: { 'content-type': 'application/wasm' } }),
    ) as typeof fetch;
    const scene = sceneWith();
    const ok = await scene.enableWasmTransforms(new URL('https://cdn.example/vectojs_core.wasm'));
    expect(ok).toBe(true);
    expect(scene.transformBackend).toBe('wasm');
  });

  it('enableWasmTransforms still accepts raw bytes and stays on JS on failure', async () => {
    const scene = sceneWith();
    expect(await scene.enableWasmTransforms(wasmBytes())).toBe(true);
    const scene2 = sceneWith();
    expect(await scene2.enableWasmTransforms(new Uint8Array([9, 9, 9]))).toBe(false);
    expect(scene2.transformBackend).toBe('js');
  });
});
