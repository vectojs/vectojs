/**
 * Resolved URL of the prebuilt force-kernel WebAssembly, co-located with this
 * module in the published package (`dist/wasm/vectojs_force.wasm`). Import it
 * and hand it to {@link VectoForceLayout.enableWasmForce}:
 *
 * ```ts
 * import { forceWasmUrl } from '@vectojs/graph3d/wasm';
 * await layout.enableWasmForce(forceWasmUrl);
 * ```
 *
 * Why a helper module rather than a bare specifier: `new URL('@vectojs/graph3d/…',
 * import.meta.url)` does NOT work — `new URL` only resolves *relative* refs
 * against a base, and a bare package specifier is not relative, so it never goes
 * through package `exports`. Resolving `./vectojs_force.wasm` from *inside* the
 * package (where this file sits next to the binary) is the only form that both
 * native ESM and bundlers resolve correctly.
 *
 * The WASM is an optional accelerator: if a bundler tree-shakes this URL away or
 * a runtime can't fetch it, `enableWasmForce` simply returns `false` and the
 * layout stays on the identical-output JS Barnes-Hut path.
 */
export const forceWasmUrl: URL = new URL('./vectojs_force.wasm', import.meta.url);
