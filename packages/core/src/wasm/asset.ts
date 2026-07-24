/**
 * Resolved URL of the prebuilt WebAssembly core, co-located with this module in
 * the published package (`dist/wasm/vectojs_core.wasm`). Import it and hand it
 * straight to any of the Scene WASM opt-ins:
 *
 * ```ts
 * import { coreWasmUrl } from '@vectojs/core/wasm';
 * await scene.enableWasmTransforms(coreWasmUrl);
 * await scene.enableWasmAnimBatching(coreWasmUrl);
 * await scene.enableWasmHitTest(coreWasmUrl);
 * ```
 *
 * Why a helper module rather than a bare specifier: `new URL('@vectojs/core/…',
 * import.meta.url)` does NOT work — `new URL` only resolves *relative* refs
 * against a base, and a bare package specifier is not relative, so it never
 * goes through package `exports`. Resolving `./vectojs_core.wasm` from *inside*
 * the package (where this file sits next to the binary) is the only form that
 * both native ESM and bundlers resolve correctly.
 *
 * The WASM is an optional accelerator: if a bundler tree-shakes this URL away or
 * a runtime can't fetch it, every `enableWasm*` call simply returns `false` and
 * the scene stays on the identical-output JS path. Nothing here is required for
 * `@vectojs/core` to work.
 */
export const coreWasmUrl: URL = new URL('./vectojs_core.wasm', import.meta.url);
