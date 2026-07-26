/**
 * A single compiled-and-instantiated `vectojs_core.wasm` shared by every WASM
 * backend of one Scene.
 *
 * Before this, each of the four accelerators (transform, animation, hit-test,
 * particle) carried its own copy of the same three-way loader and instantiated
 * the binary independently. A Scene enabling all four therefore compiled the same
 * module up to four times and held four separate linear memories, plus four sets
 * of module-level static state.
 *
 * Nothing required that: the Rust crate already keeps the transform, anim, hit
 * and particle stores in distinct statics, so they do not alias inside one
 * instance. The separate instances bought isolation that was already there, and
 * paid for it in compile time and memory.
 *
 * Two levels of sharing:
 *
 * - The compiled {@link WebAssembly.Module} is cached **globally** per source, so
 *   a second Scene (or a re-enable after `destroy()`) skips compilation.
 * - The {@link WebAssembly.Instance} is created **per runtime**, so two Scenes
 *   never share mutable stores. That isolation is the part that matters.
 *
 * Backends stay independently gated: holding a runtime does not mean every
 * accelerator is active. Each `enableWasm*` still decides whether its workload
 * clears its own threshold.
 */
import { WasmTransformBackend } from './backend';
import { AnimBackend } from './anim-backend';
import { HitTestBackend } from './hit-backend';
import { ParticleBackend } from './particle-backend';

/** Anything a core module can be loaded from. Matches the per-backend loaders. */
export type CoreModuleSource = BufferSource | string | URL | Response | Promise<Response>;

/**
 * Global compiled-module cache, keyed by the string form of a URL/path source.
 *
 * Raw bytes are deliberately **not** cached: a `BufferSource` has no stable
 * identity to key on, and hashing it would cost more than the compile it saves.
 * Tests and workers pass bytes, and they instantiate once anyway.
 */
const moduleCache = new Map<string, Promise<WebAssembly.Module>>();

function cacheKey(source: CoreModuleSource): string | null {
  if (typeof source === 'string') return source;
  if (source instanceof URL) return source.href;
  return null;
}

async function compile(source: CoreModuleSource): Promise<WebAssembly.Module> {
  if (source instanceof ArrayBuffer || ArrayBuffer.isView(source)) {
    return new WebAssembly.Module(source);
  }

  const response =
    typeof source === 'string' || source instanceof URL
      ? await fetch(String(source))
      : await source;

  // `compileStreaming` avoids buffering the whole binary, but rejects when the
  // server sends the wrong MIME type — a common static-host misconfiguration —
  // so keep a buffered retry rather than failing to a JS fallback the caller
  // explicitly opted out of.
  if (typeof WebAssembly.compileStreaming === 'function') {
    const buffered = response.clone();
    try {
      return await WebAssembly.compileStreaming(response);
    } catch {
      return await WebAssembly.compile(await buffered.arrayBuffer());
    }
  }
  return await WebAssembly.compile(await response.arrayBuffer());
}

/**
 * Compile a core module, reusing the global cache when the source is a
 * URL or path. Returns `null` on any failure (CSP `wasm-unsafe-eval`, 404,
 * corrupt bytes, unsupported) so callers keep the JS path.
 */
export async function loadCoreWasmModule(
  source: CoreModuleSource,
): Promise<WebAssembly.Module | null> {
  const key = cacheKey(source);
  if (key !== null) {
    const hit = moduleCache.get(key);
    if (hit) {
      // A previously cached *rejection* must not poison the cache — drop it and
      // let the caller retry (a transient 503 should not disable WASM forever).
      try {
        return await hit;
      } catch {
        moduleCache.delete(key);
        return null;
      }
    }
  }

  const pending = compile(source);
  if (key !== null) moduleCache.set(key, pending);
  try {
    return await pending;
  } catch {
    if (key !== null) moduleCache.delete(key);
    return null;
  }
}

/**
 * One instance of the core module, exposing every backend that instance can
 * serve. All four share its linear memory, which is why they must come from the
 * same instantiation rather than four independent ones.
 */
export class CoreWasmRuntime {
  public readonly instance: WebAssembly.Instance;

  private transformBackend: WasmTransformBackend | null = null;
  private animBackend: AnimBackend | null = null;
  private hitBackend: HitTestBackend | null = null;
  private particleBackendInstance: ParticleBackend | null = null;

  constructor(instance: WebAssembly.Instance) {
    this.instance = instance;
  }

  /**
   * Backends are constructed lazily and memoised: each one's constructor calls
   * into the instance to size its store and build typed-array views, so building
   * all four up front would pay for accelerators the Scene never enables.
   */
  public transform(): WasmTransformBackend {
    if (!this.transformBackend) this.transformBackend = new WasmTransformBackend(this.instance);
    return this.transformBackend;
  }

  public anim(): AnimBackend {
    if (!this.animBackend) this.animBackend = new AnimBackend(this.instance);
    return this.animBackend;
  }

  public hit(): HitTestBackend {
    if (!this.hitBackend) this.hitBackend = new HitTestBackend(this.instance);
    return this.hitBackend;
  }

  public particle(): ParticleBackend {
    if (!this.particleBackendInstance)
      this.particleBackendInstance = new ParticleBackend(this.instance);
    return this.particleBackendInstance;
  }
}

/**
 * Instantiate a runtime from an already-compiled module. Separated from
 * {@link loadCoreWasmModule} so several Scenes can share one compile while each
 * keeps its own mutable stores.
 */
export function createCoreWasmRuntime(module: WebAssembly.Module): CoreWasmRuntime | null {
  try {
    return new CoreWasmRuntime(new WebAssembly.Instance(module, {}));
  } catch {
    return null;
  }
}

/**
 * Compile (or reuse) and instantiate in one step. Returns `null` on any failure
 * so the caller keeps the JS path.
 */
export async function loadCoreWasmRuntime(
  source: CoreModuleSource,
): Promise<CoreWasmRuntime | null> {
  const module = await loadCoreWasmModule(source);
  if (!module) return null;
  return createCoreWasmRuntime(module);
}

/**
 * Drop the global compiled-module cache. For tests that need to observe a fresh
 * compile, and for apps that want to release the memory after teardown.
 */
export function clearCoreWasmModuleCache(): void {
  moduleCache.clear();
}
