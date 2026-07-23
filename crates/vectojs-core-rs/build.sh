#!/usr/bin/env bash
# Build the @vectojs/core WASM transform backend for wasm32-unknown-unknown.
#
# RUSTFLAGS is set explicitly rather than relying on crate-local
# .cargo/config.toml: a global [target.'cfg(all())'] section matches wasm32 and
# Cargo JOINS its rustflags with target-specific ones, so host CPU flags and
# alternative linkers (e.g. -fuse-ld=mold) leak in and break the link. Env
# RUSTFLAGS REPLACES config rustflags outright — the only reliable override.
#
# Output is packages/core/src/wasm/vectojs_core.wasm, which is gitignored: the
# asset is built in CI and published to npm, never committed. Contributors who
# touch only TypeScript never need a Rust toolchain — the JS path always works.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
out_dir="$here/../../packages/core/src/wasm"
mkdir -p "$out_dir"

RUSTFLAGS="-C target-cpu=generic -C target-feature=+simd128 -C linker=rust-lld" \
  cargo build --release \
  --target wasm32-unknown-unknown \
  --manifest-path "$here/Cargo.toml"

artifact="$here/target/wasm32-unknown-unknown/release/vectojs_core_rs.wasm"
cp "$artifact" "$out_dir/vectojs_core.wasm"
printf 'built %s (%s bytes)\n' \
  "$out_dir/vectojs_core.wasm" "$(stat -c%s "$out_dir/vectojs_core.wasm")"
