---
"@vectojs/core": patch
---

Raise the default `Scene.animDriverGateCount` from 128 to 256, based on a re-run of the integrated `benchmarks/anim-wasm-scene` sweep on real Chrome 150 and Firefox 153 (0 correctness mismatches across spring/tween/mixed). The previous 128 default was validated only in aggregate; broken out by driver kind, pure-tween scenes are a net LOSS at n=128 on Chrome (0.71×, ~40% slower than the JS tick path) and only turn net-positive around n≈256, while spring/mixed win from n=128 up. 256 keeps the gate net-positive across all three driver kinds rather than opening early on a tween-heavy scene and making it slower. This only affects apps that opt into WASM animation batching via `enableWasmAnimBatching`; the JS tick path (default) is unchanged, and the gate remains a public field you can tune for your own browser/driver mix.
