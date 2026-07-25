---
"@vectojs/core": minor
---

Add an optional WASM particle-simulation backend (G4) for `ComputeParticleEntity`'s CPU fallback. The per-frame particle step (spring-to-origin, mouse repulsion, explosion impulse, velocity integrate + damp + cap, boundary bounce + clamp, life decay) over 10k–100k particles now has a WASM kernel (`crates/vectojs-core-rs/src/particle.rs`) that advances the whole buffer in one call, replacing the per-particle JS `updateCPU` loop on the path that runs exactly when there is no GPU. It also fuses the separate `hasPendingAnimations` full-buffer scan into the step's return flag.

Opt-in and invisible, matching the transform/hit/anim backends: `scene.enableWasmParticles(coreWasmUrl)` (or `setParticleBackend`) installs it; `scene.particleSimBackend` reports the active path; `updateCPU` (f64) remains the permanent fallback when no backend is installed or the scene runs on WebGPU. The kernel commits to **f32** (matching the `Float32Array` buffer and the WGSL compute shader) and is a _separate_ differential oracle from the f64 transform core: it is bit-identical to a JS f32 reference (`particleStepReferenceF32`, verified over 60 steps across spring/mouse/explosion/clamped scenarios), and differs from `updateCPU`'s f64 by <1 ULP/step — the accepted CPU-vs-GPU-class divergence.

Real-hardware benchmark (`benchmarks/particle-wasm`, Chrome 150 + Firefox 153), including the per-frame AoS↔SoA transpose in the WASM timing: **~2.1–2.5× on Chrome and ~1.4–2.0× on Firefox** across 1k–100k particles (e.g. 100k: 4.60 ms → 2.18 ms Chrome, 2.59 ms → 1.30 ms Firefox per frame). Baselines in `vectojs-docs/forge/baselines/particle-wasm-*`.
