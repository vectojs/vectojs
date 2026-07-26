---
'@vectojs/core': patch
---

Stop shipping the rejected f32x4 benchmark kernel in the released WASM binary.

`simd_f32_bench` was declared unconditionally and the crate had no `[features]`
section, so the f32x4 compose prototype was compiled into every published
`vectojs_core.wasm`. That kernel had already been measured and **rejected**: f32
error accumulates along a transform chain (~93px on a deep tree), and it is not
bit-comparable to the JS reference the differential suite is built on. It was dead
weight in every download.

It now sits behind a `bench-f32` Cargo feature, off by default. Measured saving:
**36,816 → 33,792 bytes (3,024 bytes, 8.2%)**.

`benchmarks/f32-simd-eval` still works, with an explicit build step:

```bash
./crates/vectojs-core-rs/build.sh --features bench-f32
```

Run against a default build, the bench now reports the missing kernel and how to
enable it, instead of failing on an undefined export several frames in.
