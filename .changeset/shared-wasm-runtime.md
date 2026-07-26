---
'@vectojs/core': minor
---

Share one WASM instance per Scene across all four accelerators.

Each `enableWasm*` previously instantiated `vectojs_core.wasm` itself, so a Scene
enabling transforms, animation, hit-test and particles compiled the same binary
up to four times and held four separate linear memories plus four sets of
module-level statics. Nothing required that: the Rust crate already keeps those
four stores in distinct statics, so they do not alias within a single instance.

Now the compiled `WebAssembly.Module` is cached globally per URL source, and one
`Instance` is created per Scene. Sharing a compile is safe; sharing mutable stores
is not, so two Scenes still get separate instances.

New public API:

- `Scene.wasmRuntime` — the shared runtime, or `null`.
- `Scene.setWasmRuntime(runtime)` — install a pre-built runtime so several Scenes
  can share one compile.
- `loadCoreWasmModule`, `createCoreWasmRuntime`, `loadCoreWasmRuntime`,
  `clearCoreWasmModuleCache` from `@vectojs/core`.

Behaviour is unchanged: every `enableWasm*` still returns `boolean`, still falls
back to JS on any failure (CSP, 404, corrupt bytes, unsupported SIMD), and each
accelerator keeps its own independent gate. A failed load is no longer cached, so
one transient 503 cannot disable WASM for the page's lifetime.

This is also the prerequisite for fusing transform -> AABB -> hit-grid inside one
instance, which is what makes the cold hit-test path viable.
