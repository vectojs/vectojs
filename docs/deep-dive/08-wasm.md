---
title: "08 — WASM Accelerators — G1/G2/G3 & Bit-Parity"
description: "The invisible WASM backends behind @vectojs/core: G1 world-matrix, G2 animation batch, G3 hit-grid (plus G4 particles), the SoA store that makes SIMD possible, and the bit-parity contract that keeps WASM optional."
order: 28
---

# 08 — WASM Accelerators — G1/G2/G3 & Bit-Parity

> **Boss 08** is invisible by design. The Rust kernels (`crates/vectojs-core-rs`, `crates/vectojs-force-rs`) accelerate what the JS engine already does correctly — world-matrix composition, animation ticks, hit broad-phase, particle integration — and never become required. Every accelerated path has a JS fallback that produces the _same bits_, and every build, gate, and test is there to keep that promise.

- **What you'll learn**: why WASM is an invisible backend; the SoA store that makes `f64x2` possible; what G1/G2/G3(+G4) each accelerate, how they are gated, and what the headed benchmarks actually measured; how bit-parity is tested; and how to add a new kernel without breaking the fallback contract.
- **What you won't**: VMT dirty/lifecycle (boss 06), renderer/DPR parity (boss 07), graph-layout tuning (boss 11), or the Three/XR two-world mapping (boss 09). This doc is the acceleration layer _between_ VMT and renderer.

## 1. Why WASM is an invisible backend

VectoJS runs correctly with zero Rust. `packages/core/src/wasm/soa.ts:1` (`composeJS`, `computeAabbsJS`) and `packages/math/src/SpringPhysics.ts:1` / `packages/animation/src/easing.ts` are the _permanent_ oracles and fallbacks; the crate manifests say it explicitly — `crates/vectojs-core-rs/Cargo.toml:6` _"invisible backend; the TypeScript path is the permanent fallback"_ and `crates/vectojs-force-rs/Cargo.toml:6` the same for the force kernel. The compiled `.wasm` itself is gitignored (`packages/core/src/wasm/vectojs_core.wasm`, `packages/graph3d/src/wasm/vectojs_force.wasm`) — built in CI, published to npm, never committed (`.carryctx/rules/wasm-crate-build.md:6`).

Three constraints follow from that single decision:

1. **Instantiation can fail and must be silent.** CSP `wasm-unsafe-eval`, missing asset, unsupported `simd128`, stale cached module — every loader returns `null` and the caller keeps the JS path. `packages/core/src/wasm/backend.ts:467` `instantiateSync`/`instantiateAsync`/`instantiateStreaming`, `packages/core/src/wasm/runtime.ts:48` `loadCoreWasmModule`/`createCoreWasmRuntime`, `packages/graph3d/src/wasm/force-backend.ts:55` the force equivalent, and `packages/core/src/wasm/asset.ts:22` `coreWasmUrl` / `packages/graph3d/src/wasm/asset.ts:22` `forceWasmUrl` for bundler resolution. Failure is the default state, not an error path.

   The URL helper matters: `new URL('@vectojs/core/…', import.meta.url)` does not work — `new URL` only resolves _relative_ refs, and a bare specifier is not relative (`asset.ts:10`). `new URL('./vectojs_core.wasm', import.meta.url)` from _inside_ the package is the only form both native ESM and bundlers resolve correctly. Callers do `await scene.enableWasmTransforms(coreWasmUrl)` (`asset.ts:8` example) and the method returns `false` when the fetch/compile fails (`Scene.ts:1704` `enableWasmTransforms` docs: _"resolves true if WASM is now active, false if the JS path remains"_ ).

2. **Kernels must be fallible, not trapping.** Exports return `STATUS_OK` (0) or a non-zero `STATUS_CAPACITY/UNINITIALIZED/BAD_RUN/OVERFLOW` (`crates/vectojs-core-rs/src/lib.rs:485` constants, `packages/core/src/wasm/backend.ts:16` `WASM_STATUS`) and write _nothing_ on rejection. The JS side treats any non-zero as "run the reference path this frame" (`packages/core/src/wasm/backend.ts:212` `compose` early-return, `packages/core/src/wasm/anim-backend.ts:173` `stepSprings` boolean, `packages/core/src/tree/scene/WasmBackendFacade.ts:487` upload-retry, `packages/core/src/wasm/particle-backend.ts:110` tri-state negative status).

3. **Shared linear memory, shared module.** Before `packages/core/src/wasm/runtime.ts:1` (`CoreWasmRuntime`), four backends meant four compiles and four linear memories for the same binary. Now one `WebAssembly.Module` is cached globally per URL (`runtime.ts:38` `moduleCache`, keyed only on string/URL — bytes are not cached, `runtime.ts:48` `cacheKey` docs) and one `Instance` per `Scene` exposes all four stores via distinct `static mut` statics that never alias (`crates/vectojs-core-rs/src/lib.rs:44` `Store`, `src/anim.rs:44` `Anim`, `src/hit.rs:44` `Hit`, `src/particle.rs:44` `Particles`, `crates/vectojs-force-rs/src/lib.rs:44` `Octree`+`POS`/`ACCEL`). `CoreWasmRuntime` constructs each backend lazily and memoises it (`runtime.ts:90` `transform()`/`anim()`/`hit()`/`particle()`) so a Scene that only enables transforms never pays anim/hit allocation.

Reporting keeps "installed" and "active this frame" separate. `Scene.accelerators: AcceleratorReport` (`WasmBackendFacade.ts:122` report shape, `Scene.ts:1749` doc _"Definite-assignment because it needs \_wasmBackend"_) returns `{ available, activeThisFrame, reason, path }` per accelerator — `available` is "backend installed, gate permitting", `activeThisFrame` is "actually ran", `reason` is `not-installed | below-gate | rejected | active` (`WasmBackendFacade.ts:75` `AcceleratorReason`). `Scene.animGate` vs `Scene.animBackend` is the classic confusion: a gate below the driver count makes `animBackend==='wasm'` while `animBatchedLastFrame===false` (see `Scene.ts:1749` and `Scene.ts:1904` gate docs).

## 2. Build discipline — `just wasm`, not bare cargo

The trap is `~/.cargo/config.toml` (`.carryctx/rules/wasm-crate-build.md:1`): a `[target.'cfg(all())']` section matches `wasm32` too, and Cargo _joins_ its `rustflags` with target-specific ones. Host flags like `-C target-cpu=native` or `-fuse-ld=mold` leak into the `wasm32-unknown-unknown` link and break it (`rust-lld: error: unknown argument: -fuse-ld=mold`). Env `RUSTFLAGS` _replaces_ config flags; target-specific config does not.

The only correct build:

```bash
just wasm  # runs crates/vectojs-core-rs/build.sh with correct RUSTFLAGS
# or for the force kernel:
# crates/vectojs-force-rs/build.sh  (same RUSTFLAGS)

# what build.sh does (crates/vectojs-core-rs/build.sh:28):
RUSTFLAGS="-C target-cpu=generic -C target-feature=+simd128 -C linker=rust-lld" \
  cargo build --release --target wasm32-unknown-unknown --manifest-path crates/vectojs-core-rs/Cargo.toml
```

Rule details (`crates/vectojs-core-rs/build.sh:1`, `crates/vectojs-force-rs/build.sh:1`, `.carryctx/rules/wasm-crate-build.md:1`):

| rule                                                           | file:line                                                        | why                                                                                                                                                                                                                               |
| -------------------------------------------------------------- | ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `target-cpu=generic`                                           | `build.sh:28`                                                    | keeps `fma` (fused multiply-add) out. `generic` has no `fma`; a host-tuned CPU would fuse `a*b + c*d` into one rounding, while JS does two — breaking bit-parity. `crates/vectojs-force-rs/build.sh:8` calls this out explicitly. |
| `target-feature=+simd128`                                      | `build.sh:28`                                                    | enables `v128`/`f64x2`/`f32x4`. Without it the `#[target_feature(enable="simd128")]` kernels (`lib.rs:612`, `particle` comments) fail to compile or trap.                                                                         |
| `linker=rust-lld`                                              | `build.sh:28`                                                    | overrides any `~/.cargo/config` linker like `mold`.                                                                                                                                                                               |
| `panic="abort"` + `strip` + `lto` + `codegen-units=1`          | `Cargo.toml:22`                                                  | minimal, deterministic binary.                                                                                                                                                                                                    |
| `edition="2024"` + `rust-toolchain.toml:10` `channel="stable"` | `rust-toolchain.toml:1`, `.carryctx/rules/wasm-crate-build.md:3` | exact channel pin is _stable_, not a version — an exact-version pin breaks offline/mirror boxes; CI pins the exact version instead.                                                                                               |
| `just wasm-check`                                              | `.carryctx/rules/wasm-crate-build.md:5`                          | `cargo fmt --check` + `cargo clippy --target wasm32-unknown-unknown -- -D warnings` with the same `RUSTFLAGS`.                                                                                                                    |
| `just wasm-test`                                               | `.carryctx/rules/wasm-crate-build.md:5`                          | `just wasm` then the core differential suite (`vitest`).                                                                                                                                                                          |
| binary gitignored                                              | `build.sh:14`, `.carryctx/rules/wasm-crate-build.md:6`           | TS-only contributors never need Rust. Published via `tsup.config.ts:40` copy step (`packages/graph3d/tsup.config.ts:40` `vectojs_force.wasm → dist/wasm/`).                                                                       |
| `Cargo.toml` `publish=false`                                   | `Cargo.toml:5` (both crates)                                     | crates are not crates.io packages — only the `.wasm` via npm matters.                                                                                                                                                             |

The `f32x4` evaluation kernel (`crates/vectojs-core-rs/src/simd_f32_bench.rs:1`) is behind `bench-f32` (`Cargo.toml:20` `bench-f32 = []`) and never shipped — measured and rejected. `build.sh:18` documents the opt-in form `./build.sh --features bench-f32` and why the default excludes it: f32 was measured and rejected.

## 3. The SoA store — the shape that makes SIMD reachable

`packages/core/src/wasm/soa.ts:22` is half the system; `crates/vectojs-core-rs/src/lib.rs:1` is the other. The doc comment at `lib.rs:10` is load-bearing:

> One flat `f64` array per field. With an interleaved record, consecutive entities' `x` would be `N*8` apart — a `v128` load cannot fetch two of them.

### 3.1 SoA, not AoS

`Store` (`lib.rs:44`) holds 22 `*mut f64` input/output/bounds/AABB arrays plus 3 `*mut i32` run tables. JS side: `TransformStore` (`soa.ts:44`) with matching `Float64Array`/`Int32Array` views laid over `WebAssembly.Memory.buffer` via exported pointers (`lib.rs:564` `ptr_export!`, `backend.ts:178` `p_x()…p_run_len()`).

### 3.2 Sibling runs, depth-ordered

WASM SIMD has no gather. Vectorising across arbitrary parents would need per-entity parent-matrix loads. Instead `soa.ts:178` `buildStore` guarantees _children of one parent are contiguous_ (BFS per parent: dequeue a parent, emit all children as one run, enqueue them). The parent world matrix is splatted once per run (`lib.rs:640` `f64x2_splat(*S.wa.add(p))`) and the children fill both lanes. `store.runStart/runLen/runParent` is the iteration table; `set_run_count` (`lib.rs:600`) publishes its length.

The JS builder validates: exactly one `parent===-1` root (throws on missing/duplicate, `soa.ts:104`), every parent index in range (`soa.ts:112`), root at store index 0 seeded to identity (`lib.rs:603` `seed_root`, `soa.ts:246` `composeJS` seeds `wa[0]=1,wd[0]=1`). Between rebuilds the per-frame sync only gathers current `x/y/scale/rotation/opacity` into the resident input view and re-runs the kernel (`WasmBackendFacade.ts:458` `syncStore`).

### 3.3 Padding, alignment, and precomputed trig

**Padding, not remainder loop.** `init` (`lib.rs:370`) allocates `capacity + 8` (and `simd_f32_bench.rs:128` uses `+16` for `f32x4`). An odd-length tail reads one slot past the logical end — the padding lane is written but never read back (`lib.rs:643` `compose_simd` comment, `backend.ts:152` upload comment). The JS store mirrors the padding (`soa.ts:64` `capacity = count + 8`).

**Precomputed `cos`/`sin`.** WASM has no transcendentals; recomputing per frame was the largest cost in round 1 (`lib.rs:66`). JS writes `cos=Math.cos(rotation)` once per build (`soa.ts:218` `writeInput`), and the per-frame resident gather reads the cached `_getTrig()` (`WasmBackendFacade.ts:544` + `Entity.ts:1746` trig cache).

**16-byte alignment.** `SIMD_ALIGN=16` (`lib.rs:84`). `leak_f64` uses `alloc_zeroed` with 16-byte align — `Vec<f64>` is only 8-byte aligned and makes `v128_load` on SpiderMonkey ~7x slower (measured, per `lib.rs:84` comment). The helper returns null on OOM rather than trapping, so `init` can report `STATUS_OVERFLOW` and leave the previous store intact (`lib.rs:340` `free_store` + overflow path).

### 3.4 Shared-memory view hazards

All four core-rs backends (and every `Scene`) share one `WebAssembly.Memory`. Any `*_init` can grow memory and detach every other backend's `TypedArray` views (read as `byteLength===0`). Hence `backend.ts:373` `revalidateViews` / `viewsStale` (`backend.ts:38` helper) and `anim-backend.ts:121` / `hit-backend.ts:111` / `particle-backend.ts:112` the same, plus `WasmBackendFacade.ts:527` cross-backend re-acquire after `syncStore` gather. The transform backend also probes `typeof ex.compose_simd === "function"` (`backend.ts:201`) so a stale cached `.wasm` predating `compute_aabbs_simd` degrades to scalar rather than throwing (`#798`, `aabb-stale-module.test.ts`).

## 4. G1 — world-matrix composition (+ AABB)

**What it accelerates:** the `Canvas T * S * R` composition (`lib.rs:520` `compose_scalar` / `lib.rs:612` `compose_simd`, `soa.ts:246` `composeJS`) and the subsequent world-space AABB pass (`lib.rs:670` `compute_aabbs` / `lib.rs:790` `compute_aabbs_simd`, `soa.ts:316` `computeAabbsJS`). Every entity's world matrix (`a,b,c,d,e,f,opacity`) is `parentMatrix * T(x,y) * S(sx,sy) * R(cos,sin)`, then its local bounds `[bx,by,bw,bh]` are pushed through it to the world AABB (`aminx…amaxy`).

**How it reaches `Scene`:** `buildTreeStore` (`packages/core/src/wasm/scene-store.ts:30`) walks `Entity.children` into `InputNode[]` and `buildStore`; `WasmBackendFacade` (`packages/core/src/tree/scene/WasmBackendFacade.ts:168` transform region, `WasmBackendFacade.ts:458` `syncStore`) hot-swaps via `Scene.enableWasmTransforms` (`Scene.ts:1706`). Two integration costs exist (see `benchmarks/core-wasm/entry.ts:1`): `copy` (upload+kernel+readback — re-uploads every `Float64Array` then reads back `wa…wo`) vs `resident` (kernel only, inputs/outputs already in WASM views). Resident — accessors write directly into `inputView()`/`boundsView()` and the renderer reads `worldView()`/`aabbView()` (`backend.ts:320`/`backend.ts:420`, `WasmBackendFacade.ts:518` world-view return) — is the designed path and is what the benchmarks report as `resident`.

**Measured wins** (`benchmarks/core-wasm/results/latest/core-wasm-chrome.json:1`, 2026-08-14, i7-14650HX, Chrome 151, `benchmarks/run-browsers.sh` — the only quotable harness, see global AGENTS.md):

| topology | n    | js ns/elem | copy ns/elem | resident ns/elem | resident speedup | AABB speedup |
| -------- | ---- | ---------- | ------------ | ---------------- | ---------------- | ------------ |
| flat     | 1k   | 4.8        | 4.83         | 2.73             | 1.76×            | ~1.0×        |
| flat     | 10k  | 4.26       | 5.37         | 2.77             | 1.54×            | 1.95×        |
| flat     | 100k | 4.55       | 8.64         | 3.57             | 1.27×            | 2.09×        |
| chain    | 1k   | 14.73      | 10.23        | 8.13             | 1.81×            | 1.14×        |
| chain    | 10k  | 15.25      | 10.1         | 7.15             | 2.13×            | 1.10×        |
| chain    | 100k | 16.25      | 13.63        | 7.35             | 2.21×            | 1.08×        |
| bushy    | 10k  | 10.46      | 8.25         | 4.72             | 2.21×            | 1.99×        |
| bushy    | 100k | 12.24      | 11.41        | 5.69             | 2.15×            | 2.22×        |

Firefox on the same host is closer: e.g. flat 1k `resident 1.15×`, chain 1k `2.63×` (`core-wasm-firefox.json:1`). The engine gap is real — the `run-browsers.sh` contract requires reporting both.

The copy path can be _slower_ than JS at small/medium fan-out (flat 1k `0.995×`, flat 10k `0.79×`, `entry.ts:80` `copy` measurement), because two `Float64Array.set` plus two reads dominate; the doc at `entry.ts:1` warns the resident number is the fair comparison for Phase 1. The AABB pass alone reaches ~2.2× at scale because it is lane-paired without a run walk and its min/max reduction is associative under the total-order `js_min/js_max` (`lib.rs:790` proof on `f64x2_min/max` NaN/±0 semantics).

**Why `f32x4` was rejected:** `Cargo.toml:14` + `lib.rs:20` / `simd_f32_bench.rs:1` — f32 carries ~7 significant digits (`lib.rs:6` comment: _"~93px error on a deep/bushy tree in #143"_) and is not bit-comparable to the JS reference. The 4-lane kernel (`simd_f32_bench.rs:128` `+16` pad, `f32x4_splat/mul/add` at `simd_f32_bench.rs:300`) is bench-only, gated behind `bench-f32` (`Cargo.toml:20`) so it never ships, and has its own unfused store `SF` (`simd_f32_bench.rs:44`).

## 5. G2 — batched animation drivers (spring + tween)

**What it accelerates:** advancing _all_ currently-active `SpringDriver`/`TweenDriver` instances in one `spring_step`/`tween_step` call (`crates/vectojs-core-rs/src/anim.rs:1`) instead of the JS per-driver `driver.tick()` loop (`packages/core/src/tree/scene/DriverTicker.ts:131` `tick`).

**Bit-parity — now exact.** `anim.rs:8` notes this was a measurement spike that now matches bit-for-bit. Both sides write integer powers as explicit multiplication (`t*t`, `t*t*t`, `-2*t+2` in `anim.rs:360` `ease` and `packages/animation/src/easing.ts`), not `Math.pow`/`powi` — neither is correctly rounded, and the old pairing diverged at ~1e-12. Spring constants (`anim.rs:12` `MAX_FRAME_DT=0.25`, `MAX_STEP_DT=1/120`, `VAL_EPSILON/VEL_EPSILON=0.005`) mirror `packages/math/src/SpringPhysics.ts:5` (`MAX_FRAME_DT=0.25`, `MAX_STEP_DT=1/120`, `SpringPhysics.ts:59` epsilons). The tween terminal snap (`anim.rs:410` _"must be exactly `to` once `active>=dur`"_) matches `packages/animation/src/drivers.ts` `TweenDriver.tick` so a custom easing that does not satisfy `f(1)===1` still lands.

**Gating — count matters.** Unlike G1 (100k nodes every frame), active driver counts are usually small, so batching only pays above a threshold. `Scene.animGate` (`Scene.ts:1904`):

```ts
public animGate: { spring: number; tween: number; mixed: number } = {
  spring: 128, tween: 256, mixed: 128,
};
```

`DriverTicker.tick` (`DriverTicker.ts:50` `AnimGate`, `DriverTicker.ts:197` gate-open accounting, `DriverTicker.ts:64` _"O(tree size) — the exact mistake G3's first benchmark made"_) gathers active batchable drivers into dense `Float64Array` packs (`anim-backend.ts:68` `ensure` + `springView`/`tweenView`) and runs one kernel each; custom `EasingFn` tweens have `wasmEasingId === null` and stay in JS (`DriverTicker.ts:228`). Below the gate, the JS loop is kept — the `anim-wasm-scene` integrated benchmark found allocation churn dominated the cost, not the kernel (`DriverTicker.ts:68` comment referencing `benchmarks/anim-wasm`/`anim-wasm-scene`).

`Scene.animBatchedLastFrame` (`Scene.ts:2030` + `Scene.ts:1749` doc _"Definite-assignment because it holds \_wasmBackend"_) reports only whether the gate _opened_; distinct from `animBackend` ("installed"). `Scene.animThreshold` (`Scene.ts:1856`) is a back-compat alias that reads `animGate.tween` and writes all three gates at once — prefer `animGate` (a single threshold cannot be right for both kinds).

**SoA + separate store.** `anim.rs:44` `Anim` is a distinct `static mut` (`s_val/s_target/s_vel/s_stiff/s_damp/s_mass`, `t_from/t_to/t_elapsed/t_dur/t_delay/t_ease/t_val`, `spring_capacity/tween_capacity` at `anim.rs:54`) with its own `anim_init` (`anim.rs:158`) and `STATUS_*` returns — no cross-touch with the transform `Store`. The JS facade is dense-pack: every qualifying frame re-gathers all active drivers from scratch (`anim-backend.ts:20` _"no cross-frame residency"_), runs the kernel, scatters results — so drivers joining/leaving or the gate flipping costs no invalidation.

## 6. G3 — hit-test broad-phase (dense viewport grid)

**What it accelerates:** `Scene.findEntityAt` (`HitTester.ts:12`) does an `O(N)` depth-first `isPointInside` walk per pointer event (`HitTester.ts:227` `findHitRecursively`). The hit kernel (`crates/vectojs-core-rs/src/hit.rs:1`) replaces the broad phase with a uniform grid: bucket each interactive entity's world AABB into cells covering `[0,vw]×[0,vh]` at `cellSize=64`, then a point query scans only one cell and returns the _topmost_ AABB candidate (highest index — pre-order, `packages/core/src/wasm/hit-store.ts:16` invariant — larger index draws later). The caller confirms with precise `isPointInside`, so non-rectangular hits stay correct and a grid hit is conclusive (`HitTester.ts:119` _"The WASM path is conclusive"_ — no JS fallback follows a trustworthy grid).

**Scope:** dense flat `i32` arrays, not hashing — a pointer is always inside the viewport (`hit.rs:15`). Three arrays: `cell_start/cell_count` per cell, `items` for `(entity, cell)` memberships, with counting-sort build (`hit.rs:280` `hit_build`: count per cell → prefix-sum to `cell_start` → scatter). `hit_overflow()` (`hit.rs:220`) signals item-cap exhaustion; the JS side treats overflow as "grid untrustworthy, fall back" (`packages/core/src/wasm/hit-backend.ts:122` `runBuild` returns `false` on overflow). `hit_query` (`hit.rs:380`) scans only the pointer's cell and returns `-STATUS_UNINITIALIZED` when `hit_init` never ran — distinguishable from a genuine miss (`-1`).

**JS-side wiring:** `gatherHitAABBs` (`hit-store.ts:47`) walks `Entity.children` in pre-order — identical to `findHitRecursively`'s order — collecting world AABBs and a `boundless` list for entities without `getBounds()` (routed through `boundless` and never read from the AABB slots, `hit-store.ts:60`). The fused gather (`hit-store-fused.ts`) reuses the G1 world-matrix path (`WasmBackendFacade.ts:583` `ensureAabbs` + `hitGridFrame`/`hitGridStructureVersion` cache key at `WasmBackendFacade.ts:394`) instead of recomputing four corners per entity. `HitTester.ts:60` / `WasmBackendFacade.ts:150` own the viewport grid and `findEntityAtWasm` path (`WasmBackendFacade.ts:334` `setHit` invalidates the grid).

**Not `@vectojs/graph-layout`.** That package (`packages/graph-layout/src/ForceLayout2D.ts:1`, `internal/BarnesHutQuadtree.ts:1` — true-2D quadtree with first-class collision, `ZERO_TIER` sentinel at `BarnesHutQuadtree.ts:5`) is a _2D_ force layout with no WASM backend. The _3D_ force kernel is `crates/vectojs-force-rs` for `@vectojs/graph3d` (see §7).

## 7. G4 (+ graph3d force) — particle & Barnes-Hut

Two additional kernels share the same invisible-backend discipline but are not labelled G1–G3 in the transform sequence:

**G4 — particle CPU sim** (`crates/vectojs-core-rs/src/particle.rs:1`, `packages/core/src/wasm/particle-backend.ts:1`): mirrors `ComputeParticleEntity.updateCPU` (spring-to-origin, mouse repulsion, explosion impulse, integrate+damp, velocity cap, bounce+clamp, life decay). SoA `f32` (not `f64`) because the GPU/WGSL buffer is `Float32Array`; the differential oracle is `particleStepReferenceF32` (`particle-backend.ts:340`) which rounds every intermediate with `Math.fround` and uses `sqrt(dx*dx+dy*dy)` (not `Math.hypot`, correctly-rounded f64 — `particle-backend.ts:350` doc), so it is bit-identical to the kernel. The JS `updateCPU` stays `f64` and differs by <1 ULP/step — accepted CPU-vs-GPU divergence. The kernel fuses `hasPendingAnimations` (returns pending flag, `particle.rs:320` `EPS_VELOCITY/DISTANCE`) and uses negative returns for rejection so `0` ("settled") is distinguishable from failure (`particle-backend.ts:110` `step`, `particle.rs:310` `particle_step` negative-status encoding).

The SoA transpose is `gather`/`scatter` over AoS stride-8 (`particle-backend.ts:160` `gather` with `PARTICLE_STRIDE_FLOATS`/`PARTICLE_OFFSET_*` from `ComputeParticleEntity.ts`).

**Graph3D Barnes-Hut octree** (`crates/vectojs-force-rs/src/lib.rs:1`, `packages/graph3d/src/wasm/force-backend.ts:1`): builds an `f64` center-of-mass octree from `f32` positions and accumulates `f64` repulsion accelerations (`force_init`/`force_step`, `force_pos`/`force_accel` pointers). The JS oracle is `packages/graph3d/src/layout/VectoForceLayout.ts`. Build+accumulate is 78–90% of a tick (`graph3d-frame` 2026-08-17 note in `force-rs/lib.rs:18`), so the kernel replaces exactly that phase — link springs, centering, and velocity-decay integration stay in JS. Build flags are identical to G1 — `crates/vectojs-force-rs/build.sh:20` `target-cpu=generic` to keep `fma` out and preserve `a*b + c*d` rounding parity (`force-rs/build.sh:8` doc).

**`@vectojs/math` `SpatialHashGrid`** (`packages/math/src/SpatialHashGrid.ts:1`) is _not_ WASM-backed. It is the pure-JS broad-phase hash for generic entity AABBs (`MAX_CELLS_PER_AABB=64`, `query` `O(k)` cells + results, `insert`/`cellsForAABB` doc) used outside the Scene hit path. G3's WASM grid and `SpatialHashGrid` solve different problems — don't conflate them when adding spatial acceleration.

## 8. Bit-parity testing — the verification standard

Parity is not "close enough" — it is `Object.is` per lane (`packages/core/test/wasm/differential.test.ts:78` `assertBitIdentical`), which distinguishes `+0`/`-0` and treats `NaN===NaN` (via `toBe` with `Object.is` semantics). The suites run on the _same_ `buildStore` input for JS and WASM:

- `packages/core/test/wasm/differential.test.ts:1` — transform (topologies `flat|chain|bushy|mixed`, counts 1→10k, seeded `rng` at `differential.test.ts:18`, asserts both `simd` and `scalar` match, `differential.test.ts:110` scalar case, reuse across growing/shrinking scenes).
- `anim-kernel.test.ts`, `hit-kernel.test.ts`, `particle-kernel.test.ts` — G2/G3/G4 equivalents with seeded PRNGs.
- Dedicated rejection/view suites: `abi-bounds.test.ts`, `aabb-stale-module.test.ts`, `compose-stale-module.test.ts`, `scene-wasm-upload-fallback.test.ts`, `scene-wasm-aabb-rejection.test.ts`, `scene-wasm-resident.test.ts`, `scene-store.test.ts`, `view-revalidation.test.ts`, `memory-growth.test.ts`, `shared-runtime.test.ts`, `hit-fused.test.ts`.

All gate on `existsSync(wasmPath)` and `skipIf(!haveWasm)` (`differential.test.ts:14`) — missing `.wasm` skips, never fails, because JS is the fallback. Run them with `just wasm-test` (`just wasm` then `vitest`); `just wasm-check` is fmt+clippy only. The benchmark harness is separate: only `benchmarks/run-browsers.sh` headed on a dedicated Hyprland workspace with focused window + real GPU produces quotable numbers (see global AGENTS.md and `hyprland-browser-bench` skill). `benchmarks/debug-page.ts` is headless and not quotable.

Math details that would silently break parity if changed:

- `js_min`/`js_max` propagate `NaN` and treat `-0 < +0` (`lib.rs:655`, `hit.rs:220` `js_min_f32`/`js_max_f32`, `particle.rs:120` same for `f32`), matching `Math.min`/`Math.max`. Rust's `f64::min/max` and `f32::min/max` ignore `NaN` — a single `f64::min` substitution diverges on overflowed transforms where `Infinity*0 = NaN`.
- AABB SIMD reduction is associative because `js_min/js_max` implement a total order — `lib.rs:790` doc proves `f64x2_min/max` have the same NaN/zero semantics, so a lane-paired fold matches the scalar left fold bit-for-bit.
- Easing uses explicit multiplies, not `powi`/`powf` (`anim.rs:360` `ease`, `packages/animation/src/easing.ts` the JS mirror).
- Particle oracle rounds every intermediate with `Math.fround` (`particle-backend.ts:340`) and uses `sqrt(dx*dx+dy*dy)` not `Math.hypot` — `particle.rs:120` `js_min_f32/js_max_f32/js_clamp_f32` match the same Math semantics.

## 9. Fallback and gating — the resilience seams

**Status returns.** Every `*_init`/`*_step`/`compose_*`/`hit_build`/`force_step` returns `STATUS_*` (`lib.rs:485`, `anim.rs:158` `springs_ready`/`tweens_ready`, `hit.rs:110` `hits_ready`, `particle.rs:90` `particles_ready`, `force-rs/lib.rs:18` mirrored `STATUS_*`). `CAPACITY` means "count too large"; `UNINITIALIZED` means "init never called"; `BAD_RUN`/`OVERFLOW` cover run-table and allocation failures. The caller checks and falls back — the store is left untouched and views stay valid (`backend.ts:230` `ensure` early-return, referenced in 5 places; `WasmBackendFacade.ts:470` `uploadRuns` rejected path).

**Upload retry.** `WasmBackendFacade` (`WasmBackendFacade.ts:134` `WASM_UPLOAD_REJECT_LIMIT=3`, `WasmBackendFacade.ts:492` counter) counts consecutive `uploadRuns` rejections. At 3 it disables the transform backend _for this Scene's lifetime_ (`WasmBackendFacade.ts:500` flips `_mode='js'` — not a second flag — and warns once via `hasWarnedUploadFallback` at `WasmBackendFacade.ts:501`). A rejected run-table would compose the wrong tree, and a genuinely over-cap topology re-fails every frame costing `O(n)` `buildTreeStore` each retry — so consecutive, not cumulative. `WasmBackendFacade.ts:252` `setTransform` and the success path at `WasmBackendFacade.ts:515` reset the streak.

**Memory-growth invalidation.** `viewsStale` (`backend.ts:38`) checks `byteLength===0` or `buffer !== memory.buffer`; per-backend `revalidateViews` (`backend.ts:373`, `anim-backend.ts:121`, `hit-backend.ts:111`, `particle-backend.ts:112`) and the cross-backend re-acquire in `WasmBackendFacade.ts:527` after `syncStore` gather handle the shared-linear-memory growth (`hit_init` allocates its own grid arrays in the same memory).

**Stale-module probe.** `backend.ts:201` / `runAabbs` / `runKernel` check `typeof ex.compose_simd === "function"` before calling — a cached `.wasm` at a fixed URL can predate `compute_aabbs_simd` and would throw `TypeError` mid-render (`#662`/`#798`). The `rejected` path sets `_aabbsFresh=false` in both rejection branches (`WasmBackendFacade.ts:481` + `:562` + `:607`) so a fused AABB gather never reads the previous frame's stale bounds.

**Gate reporting and budgets.** `backend.available` (`WasmTransformBackend.available`, `HitTestBackend`, etc.) is "installed"; `Scene.animBatchedLastFrame` / `Scene.hitTestBackend` / `Scene.transformBackend` / `Scene.accelerators.*.reason` is "actually used" — the doc at `Scene.ts:1749` warns not to conflate them. `animGate` is three thresholds, not one (`Scene.ts:1856` `animThreshold` alias). Hit-grid cache key is `hitGridFrame` + `hitGridStructureVersion` (`WasmBackendFacade.ts:394`) — without the structure component a same-frame mutation would hit against pre-mutation geometry.

## 10. How to add a new WASM kernel safely

1. **Start in `crates/vectojs-core-rs/src/` or a sibling crate.** Give it its own `static mut` store, SoA arrays, `*_init` with `checked_add` + `checked_mul` guards and `free_*`/`free_partial_*` (see `lib.rs:370` `init` + `free_store` + `free_partial_store`, `anim.rs:158` `anim_init` + `free_anim` + `free_partial_anim`, `hit.rs:130` `hit_init` + `free_hit`), `*_ready()` predicate (`anim.rs:158` `springs_ready`), and `ptr_export!` accessors (`lib.rs:564`). Copy the shape from `anim.rs:44` or `hit.rs:44` — nothing shares the transform `Store`. Initialise the no-store sentinel as `Store::empty()`/`Anim::empty()`/`Hit::empty()` and publish it on OOM so later calls get `STATUS_UNINITIALIZED` rather than freed-memory reads (`lib.rs:120` `empty` doc).

2. **Use `f64` unless the buffer is `f32` by external contract.** The transform core is `f64`-only for parity; only `particle.rs` and `simd_f32_bench.rs` are `f32`, each with its own oracle and explicit divergence note (`particle.rs:10` _"a separate differential oracle"_). Don't add a second precision path without a measured reason and a separate differential file.

3. **Return status codes, never trap.** `STATUS_OK=0` on success, `STATUS_CAPACITY/UNINITIALIZED/BAD_RUN/OVERFLOW` on rejection — and write nothing. Mirrored in `packages/core/src/wasm/backend.ts:16` `WASM_STATUS` (and `force-rs/lib.rs:18` mirrored vocabulary doc _"Keep the two lists in sync"_). For tri-state returns (e.g. pending flag 0/1), use negative status on failure so `0` stays meaningful (`particle.rs:310` `particle_step` negative-status encoding, `particle-backend.ts:110` `flag < 0` consumer).

4. **Build via `just wasm` / `build.sh`.** Never a bare `cargo build --target wasm32-unknown-unknown`. If adding a second crate, add its own `rust-toolchain.toml:1` (`targets=["wasm32-unknown-unknown"]`, `components=["clippy","rustfmt"]`, `profile="minimal"`) and `build.sh:20` with `RUSTFLAGS="-C target-cpu=generic -C target-feature=+simd128 -C linker=rust-lld"` — see `crates/vectojs-force-rs/build.sh:20` and `rust-toolchain.toml:10` as the templates. Wire `just wasm-check` and CI toolchain provisioning (`.carryctx/rules/wasm-crate-build.md:9`).

5. **Add a JS oracle first.** Write the JS reference in the consuming package (`soa.ts:246` `composeJS`, `soa.ts:316` `computeAabbsJS`, `SpringPhysics.ts:5` + `packages/animation/src/easing.ts`, `particle-backend.ts:340` `particleStepReferenceF32`) and keep it as the shipped fallback. Match op order and `Math.min`/`Math.max` NaN semantics (`lib.rs:655` `js_min/js_max`) so `Object.is` parity is achievable. Non-batched oracles like `SpatialHashGrid.query` keep their own coarse-superset fallback contract (`SpatialHashGrid.ts:120` _"bounded by the grid's real content"_)

6. **Add a differential test.** New file under `packages/core/test/wasm/` (or `packages/graph3d/test/` for force) following `differential.test.ts:1` shape: same `buildStore`/SoA input, both paths, `assertBitIdentical` (`differential.test.ts:78`) via `toBe`/`Object.is`, seeded PRNG (`differential.test.ts:18` `rng`), skipped when `!haveWasm` (`differential.test.ts:14`), covering both `simd` and `scalar` kernels (`differential.test.ts:110`). Add bound-overflow/rejection tests (`abi-bounds.test.ts` shape) and view-revalidation tests (`view-revalidation.test.ts` shape, `memory-growth.test.ts` shape).

7. **Add the TypeScript backend facade.** New file under `packages/core/src/wasm/` following `anim-backend.ts:1`/`hit-backend.ts:1` shape: `ensure`/`revalidateViews`/`step` or `run*`, `STATUS_OK` checks, `viewsStale` helper, `instantiateSync/Async/Streaming` that return `null` on any failure (`backend.ts:467` pattern). Share the instance via `runtime.ts:1` (`CoreWasmRuntime` + `moduleCache`) — don't instantiate a second module. Revalidate after every `ensure` before writing into views (`backend.ts:373` pattern, `WasmBackendFacade.ts:527` cross-backend re-acquire).

8. **Gate it.** Add a per-feature gate in `Scene`/`WasmBackendFacade` (`Scene.ts:1904` `animGate` triple, `WasmBackendFacade.ts:134` `WASM_UPLOAD_REJECT_LIMIT`, `WasmBackendFacade.ts:394` grid cache key). Extract reporting into `WasmBackendFacade.ts:75` `AcceleratorReason`/`AcceleratorStatus`/`AcceleratorReport` so devtools can read it without reaching into four domains. Benchmark in `benchmarks/<name>-wasm/entry.ts` (`benchmarks/core-wasm/entry.ts:1`, `benchmarks/anim-wasm/entry.ts:1` two-costs model) with `run-browsers.sh` on the dedicated 240Hz workspace — only that harness produces quotable numbers (global AGENTS.md + `hyprland-browser-bench` skill, `refreshHz` + `js vs resident` speedup separately). Keep the gate default conservative: measure integrated cost (alloc churn, gather, `Math.min` semantics) not micro-kernel time.

9. **Wire `Scene` last.** Add the `enableWasm*` async loader (`Scene.ts:1706` `enableWasmTransforms` / `Scene.ts:1783` `enableWasmHitTest` / `Scene.ts:1809` `setAnimBackend` pattern) that goes through `runtime.ts:48` `loadCoreWasmModule`/`createCoreWasmRuntime` and the shared-runtime race guard at `WasmBackendFacade.ts:314` (_"A concurrent enableWasm_ may have won the race while we awaited"*). The `Scene` walk that feeds the kernel must be split from the kernel call — test the walk + JS fallback before wiring WASM (`scene-store.ts:30` `buildTreeStore` is the seam to test in isolation).

## 11. Checklist before you ship a WASM change

- [ ] `just wasm` (and `crates/vectojs-force-rs/build.sh` if touched) builds; `just wasm-check` (fmt + clippy `-D warnings`) passes.
- [ ] `just wasm-test` (WASM differential) passes — or is `skipIf(!haveWasm)` when no `.wasm` is present. No bare `cargo build` in scripts/CI.
- [ ] New kernel has `STATUS_*` returns, writes nothing on rejection, and has rejection-injected tests; JS path is the permanent fallback.
- [ ] JS oracle matches op order and `Math.min`/`Math.max` NaN/`-0` semantics; `Object.is` parity holds for NaN/±0 corners and `+16`/`+8` tail lanes.
- [ ] New typed-array views go through `viewsStale`/`revalidateViews` (and cross-backend re-acquire) and stale-module probe where applicable.
- [ ] Gate defaults are conservative and measured integrated (`benchmarks/run-browsers.sh` on headed Chrome+Firefox; report `refreshHz`, `js vs resident` speedup, and AABB speedup separately).
- [ ] Accelerator reporting updated (`WasmBackendFacade.ts:75` `AcceleratorReason` and `Scene.accelerators` getter) and `Scene.dart`/`_dirty` style doc updated if new dirty/reporting fields were added.
- [ ] `tsup` asset copy wired (`tsup.config.ts:40` pattern) if a new `.wasm` is published.

## 12. G1/G2/G3 vocabulary — what the labels mean

The labels are chronological invention order, not priority:

- **G1** — the world-matrix + AABB core (`crates/vectojs-core-rs/src/lib.rs:1`, `soa.ts:22`). The first kernel and the only one that runs every frame for every entity. Everything else is gated by workload size; G1 is gated only by "is a `.wasm` installed and did `uploadRuns` succeed."
- **G2** — the batched animation spike (`crates/vectojs-core-rs/src/anim.rs:1`). Named second because it was the next SoA carved out. Now bit-identical but started as a measurement spike — `anim.rs:1` header says _"measurement spike, not an integrated backend"_ and benchmarks `benchmarks/anim-wasm` vs `benchmarks/anim-wasm-scene` decide whether it integrates. Do not read "G2 integrates" as done.
- **G3** — the hit-test grid spike (`crates/vectojs-core-rs/src/hit.rs:1`). Same status: measurement module with its own store, gated by viewport grid size and `hit_overflow`. `hit.rs:1` header says _"measurement module, like anim"_.
- **G4** — particle sim (`crates/vectojs-core-rs/src/particle.rs:1`). Often called G4 but not in the G1/G2/G3 trio; kept separate because it is `f32` and has its own oracle. `crates/vectojs-force-rs` (octree) is _not_ G4 — it is a second crate for graph3d (different `Cargo.toml:1`, different `build.sh:1` output path).

If you add prose, keep "G1/G2/G3" as the shorthand for "transform / anim-batch / hit-grid" and name G4 and force-rs explicitly when you mean them.

## 13. Forge baselines and when to re-measure

No inline benchmark table is a baseline. The quotable numbers live in `benchmarks/core-wasm/results/latest/` (`core-wasm-chrome.json:1`, `core-wasm-firefox.json:1` — schemaVersion 1, `refreshHz`, `panelHz`, `host.{cpu,gpu,driver}`, `rows[].{identical,jsNsPerEntity,copyNsPerEntity,residentNsPerEntity,copySpeedup,residentSpeedup,jsAabbNsPerEntity,wasmAabbNsPerEntity,aabbSpeedup}`) and their `history/` snapshots. The harness contract (`benchmarks/_shared/client.ts:1` `awaitStart`/`reportResult`, `benchmarks/core-wasm/entry.ts:1` two-costs model) requires a real headed browser foregrounded on a dedicated Hyprland workspace with a focused window and real GPU (`benchmarks/run-browsers.sh:1` — only quotable path).

Re-measure when:

- Changing `lib.rs:84` `SIMD_ALIGN`, `soa.ts:64` `PAD`, `lib.rs:640` `f64x2_splat` pattern, or `build.sh:28` `RUSTFLAGS` — any of those moves the `residentSpeedup` by >10%.
- Changing `anim.rs:12` spring constants or `anim.rs:360` `ease` — re-run `benchmarks/anim-wasm` micro + `benchmarks/anim-wasm-scene` integrated (Chrome: springs `2.06×` at 100 drivers, `3.7×` at 100k; tweens `4.14×` at 100, `4.48×` at 1k — `anim-wasm-chrome.json:1` 2026-08-14) and reset `Scene.animGate` only if integrated cost justifies it.
- Touching `hit.rs:280` `hit_build` or `hit-store.ts:47` gather — re-run `benchmarks/hit-wasm` / `benchmarks/scene-hit-wasm`.
- Touching `particle.rs:310` or `force-rs/lib.rs:1` — re-run `benchmarks/particle-wasm` / `benchmarks/graph3d-frame`.

Always report Chrome _and_ Firefox with `refreshHz` beside per-frame figures; Firefox needs `layout.frame_rate` set or it reports ~60 Hz undetectably low (global AGENTS.md measurement rule + `hyprland-browser-bench` skill).

## 14. Pitfalls that have bitten this area

| pitfall                                                                      | file:line                                                      | status                                                |
| ---------------------------------------------------------------------------- | -------------------------------------------------------------- | ----------------------------------------------------- |
| `~/.cargo/config.toml` `cfg(all)` joining host flags into wasm link          | `.carryctx/rules/wasm-crate-build.md:1`, `build.sh:8`          | fixed by `RUSTFLAGS` override                         |
| `Vec<f64>` only 8-byte aligned → SpiderMonkey `v128_load` 7× slower          | `lib.rs:84` `SIMD_ALIGN`                                       | fixed by `alloc_zeroed` with 16                       |
| Stale `TypedArray` views after `WebAssembly.Memory.grow` by another backend  | `backend.ts:38` `viewsStale`, `WasmBackendFacade.ts:527`       | fixed by `revalidateViews` + cross-backend re-acquire |
| Stale cached `.wasm` predating `compute_aabbs_simd` → `TypeError` mid-render | `backend.ts:201` probe                                         | fixed by scalar fallback (`#798`)                     |
| Rejected `uploadRuns` composing wrong tree / stale AABBs                     | `WasmBackendFacade.ts:470` + `:481` `:562` `_aabbsFresh=false` | fixed by retry limit (`DEC-0014`)                     |
| `Math.pow`/`powi` vs explicit multiplies → ~1e-12 easing gap                 | `anim.rs:360` `ease`                                           | fixed by explicit `t*t`                               |
| `f64::min` ignoring NaN → diverging AABB on overflowed transforms            | `lib.rs:655` `js_min`                                          | fixed by Math-propagating `js_min/js_max`             |
| `f32` ~93px error on deep/bushy tree — shipped as dead kernel                | `simd_f32_bench.rs:1`, `Cargo.toml:20` `bench-f32`             | fixed by feature-gating                               |
| `target-cpu` enabling `fma` → single-rounding vs JS two-rounding             | `build.sh:28` `generic`                                        | fixed by `generic`                                    |
| `new URL('@vectojs/core/…', import.meta.url)` not resolving                  | `asset.ts:10`                                                  | fixed by relative `./vectojs_core.wasm`               |

## Relations

- **Boss 06 (VMT runtime)** owns the `Entity` tree, `Scene` walk, `structureVersion` → `storeStructureVersion`, and `WASM_UPLOAD_REJECT_LIMIT` wiring this boss accelerates.
- **Boss 07 (renderer)** consumes the world matrices and AABBs this boss produces — a stale view here is the next boss's version of a stale raster cache.
- **Boss 11 (graph layout)** reuses the same build discipline (`crates/vectojs-force-rs`) for 3D force; `@vectojs/graph-layout` 2D quadtree (`BarnesHutQuadtree.ts:5`) stays JS-only.
- **Boss 02 (text/layout)** and **boss 03 (projection)** are _not_ WASM-backed — don't reach for WASM when the bottleneck is shaping or DOM carriers.

## References

- `crates/vectojs-core-rs/Cargo.toml:1` — transform crate manifest (crate-type, bench-f32, release profile)
- `crates/vectojs-core-rs/src/lib.rs:1` — G1 scalar/SIMD compose + SIMD AABB, Store, status codes, `js_min/js_max`
- `crates/vectojs-core-rs/src/anim.rs:1` — G2 spring/tween batch, explicit-multiply easing, separate store
- `crates/vectojs-core-rs/src/hit.rs:1` — G3 dense viewport grid, counting-sort build, overflow
- `crates/vectojs-core-rs/src/particle.rs:1` — G4 f32 particle SoA, fused pending flag, negative-status rejection
- `crates/vectojs-core-rs/src/simd_f32_bench.rs:1` — bench-only f32x4, rejected as default (~93px error)
- `crates/vectojs-force-rs/src/lib.rs:1` — graph3d Barnes-Hut octree (f64 accumulate, f32 positions, jitter `imul`)
- `crates/vectojs-core-rs/build.sh:1` / `crates/vectojs-force-rs/build.sh:1` — correct `RUSTFLAGS` (`generic`, `+simd128`, `rust-lld`)
- `.carryctx/rules/wasm-crate-build.md:1` — build rule (just wasm, RUSTFLAGS override, gitignored binary)
- `packages/core/src/wasm/soa.ts:1` — JS SoA, `buildStore`, `composeJS`/`computeAabbsJS` oracles
- `packages/core/src/wasm/backend.ts:1` — transform backend (resident vs copy, `WASM_STATUS`, `viewsStale`, stale-module probe)
- `packages/core/src/wasm/runtime.ts:1` — shared `CoreWasmRuntime` + global module cache + lazy memoised backends
- `packages/core/src/wasm/{anim,hit,particle}-backend.ts:1` / `asset.ts:1` — G2/G3/G4 facades + `coreWasmUrl`
- `packages/core/src/wasm/{scene-store,hit-store,hit-store-fused}.ts:1` — tree → SoA / AABB gather / fused gather
- `packages/core/src/tree/scene/WasmBackendFacade.ts:1` — four backends, `AcceleratorReason/Report`, `syncStore`/`ensureAabbs`, upload retry, shared runtime
- `packages/math/src/SpringPhysics.ts:1` / `packages/math/src/SpatialHashGrid.ts:1` — JS physics/grid (JS-only, not WASM — `MAX_CELLS_PER_AABB=64`)
- `packages/core/test/wasm/differential.test.ts:1` + `anim-kernel.test.ts`/`hit-kernel.test.ts`/`particle-kernel.test.ts` — bit-identical (`Object.is`) suites, `skipIf(!haveWasm)`
- `benchmarks/core-wasm/entry.ts:1` / `benchmarks/anim-wasm/entry.ts:1` / `benchmarks/core-wasm/results/latest/:1` — headed `run-browsers.sh` measurements (Chrome+Firefox, `refreshHz`, `residentSpeedup`)
