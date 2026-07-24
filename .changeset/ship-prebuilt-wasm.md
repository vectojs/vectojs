---
"@vectojs/core": minor
---

Ship the prebuilt WebAssembly accelerator in the published package and add a `@vectojs/core/wasm` entry point to load it. Previously the `.wasm` was gitignored and never copied into `dist/` or published, so npm consumers had no binary to pass to `enableWasmTransforms`/`enableWasmAnimBatching`/`enableWasmHitTest` and were silently stuck on the JS path.

```ts
import { coreWasmUrl } from "@vectojs/core/wasm";
await scene.enableWasmTransforms(coreWasmUrl);
```

`coreWasmUrl` is a `URL` pointing at the co-located `dist/wasm/vectojs_core.wasm` (works in native ESM and CJS, and in bundlers via the standard `new URL(..., import.meta.url)` asset pattern). The raw binary is also reachable at the `@vectojs/core/vectojs_core.wasm` subpath. The WASM remains a pure accelerator: if it can't be fetched or a bundler drops it, every `enableWasm*` call returns `false` and the scene runs the identical-output JS path — nothing here is required for the package to work.
