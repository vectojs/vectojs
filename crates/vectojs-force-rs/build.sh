#!/usr/bin/env bash
# Build the @vectojs/graph3d WASM force kernel for wasm32-unknown-unknown.
#
# Mirrors crates/vectojs-core-rs/build.sh: RUSTFLAGS is set explicitly so a
# global ~/.cargo/config.toml can't leak host CPU flags (e.g. -fuse-ld=mold)
# into the wasm link; `-C target-cpu=generic` is what keeps the kernel free of
# fused-multiply-add, which would otherwise break bit-for-bit parity with the JS
# f64 oracle (the JS computes `a*b + c*d` as separate rounded ops).
#
# Output is packages/graph3d/src/wasm/vectojs_force.wasm, which is gitignored:
# the asset is built in CI and published to npm, never committed. Contributors
# who touch only TypeScript never need a Rust toolchain — the JS path always
# works.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
out_dir="$here/../../packages/graph3d/src/wasm"
mkdir -p "$out_dir"

RUSTFLAGS="-C target-cpu=generic -C target-feature=+simd128 -C linker=rust-lld" \
  cargo build --release \
  --target wasm32-unknown-unknown \
  --manifest-path "$here/Cargo.toml" \
  "$@"

artifact="$here/target/wasm32-unknown-unknown/release/vectojs_force_rs.wasm"
cp "$artifact" "$out_dir/vectojs_force.wasm"
printf 'built %s (%s bytes)\n' \
  "$out_dir/vectojs_force.wasm" "$(stat -c%s "$out_dir/vectojs_force.wasm")"
