# Rule: WASM Crate Build (crates/vectojs-core-rs and future wasm32 crates)

## Scope

Applies to any task touching `crates/*` that compiles to `wasm32-unknown-unknown`, or when creating a new Rust crate in this repo.

## Rules

1. **Never build wasm32 crates with a bare `cargo build --target wasm32-unknown-unknown`.** A global `~/.cargo/config.toml` with a `[target.'cfg(all())']` section matches wasm32 too, and Cargo _joins_ rustflags from that section with target-specific ones rather than letting the more specific entry win. A host `target-cpu=native` or `-fuse-ld=mold` will leak into the wasm build and break the link (`rust-lld: error: unknown argument: -fuse-ld=mold`).
2. **Always build through the crate's `build.sh`**, or replicate its exact `RUSTFLAGS` env-var override if scripting something new:

   ```bash
   RUSTFLAGS="-C target-cpu=generic -C target-feature=+simd128 -C linker=rust-lld" \
     cargo build --release --target wasm32-unknown-unknown --manifest-path <crate>/Cargo.toml
   ```

   Env `RUSTFLAGS` _replaces_ config rustflags outright instead of merging — the only reliable override on this host.
3. **New Rust crates use edition 2024.** `rust-toolchain.toml` pins `channel = "stable"` (not an exact version — an exact pin can make rustup try to fetch a toolchain a mirror/offline box can't serve, blocking ALL local cargo). Exact-version reproducibility is enforced at the CI layer instead.
4. **`rust-toolchain.toml` must declare** `targets = ["wasm32-unknown-unknown"]` and `components = ["clippy", "rustfmt"]` with `profile = "minimal"` so a fresh machine and CI provision identically with zero manual `rustup target add` steps.
5. **Format and lint before considering a Rust change complete**: `cargo fmt` (rustfmt) and `cargo clippy --target wasm32-unknown-unknown -- -D warnings`. Both must pass.
6. **Build output is gitignored, never committed.** The compiled `.wasm` artifact (e.g. `packages/core/src/wasm/vectojs_core.wasm`) is built in CI and published to npm as part of the package — it is not checked into git. Contributors who touch only TypeScript never need a Rust toolchain; the JS path is the permanent fallback and must keep working standalone.
7. **`Cargo.toml` release profile for wasm crates**: `opt-level = 3`, `lto = true`, `codegen-units = 1`, `panic = "abort"`, `strip = true`, `crate-type = ["cdylib"]`, `publish = false`. Follow this profile for new wasm32 crates in this workspace unless there's a documented reason to diverge.
8. **Every wasm-accelerated code path needs a working JS fallback.** The Rust/wasm kernel is an invisible performance backend, not a hard dependency — if wasm fails to load or isn't present, the TypeScript implementation must still produce correct (if slower) results.
9. **CI toolchain provisioning**: use the repo's pinned rustup toolchain action in CI workflows, not `apt`/system rustc, to guarantee CI and local builds use the same channel and components.
