# VectoJS monorepo convenience recipes.
#   just            → list every recipe
#   just <name>     → run one
# Thin wrappers over the package.json scripts + the pinned toolchain, so the
# long `bun run --filter …` / RUSTFLAGS invocations become one short word.

# Show all recipes (default when you run bare `just`).
default:
    @just --list

# --- Quality gates -------------------------------------------------------

# Format every source file in place (oxfmt — the authority).
fmt:
    @bun run format

# Full CI gate: format check + oxlint + markdownlint + actionlint.
check:
    @bun run check

# Lint only, warnings are errors (oxlint).
lint:
    @bun run lint

# All unit tests across every package.
test:
    @bun run test

# Unit tests for one package, e.g. `just test-pkg core` or `just test-pkg ui`.
test-pkg pkg:
    @bun run --filter '@vectojs/{{pkg}}' test

# Run a single vitest file, e.g. `just test-file core test/wasm/anim-kernel.test.ts`.
test-file pkg file:
    @cd packages/{{pkg}} && bunx vitest run {{file}}

# Format + lint the whole repo, then run all tests — the pre-push habit.
verify: check test

# --- Build ---------------------------------------------------------------

# Build every package in dependency order (math/text → … → three).
build:
    @bun run build

# Build one package's dist, e.g. `just build-pkg core`.
build-pkg pkg:
    @bun run --filter '@vectojs/{{pkg}}' build

# --- WASM ----------------------------------------------------------------

# Build the Rust wasm core via build.sh (sets RUSTFLAGS so a global cargo config can't leak host flags).
wasm:
    @crates/vectojs-core-rs/build.sh

# rustfmt + clippy on the wasm target, warnings as errors (matches CI).
wasm-check:
    @cargo fmt --manifest-path crates/vectojs-core-rs/Cargo.toml --check
    @RUSTFLAGS="-C target-cpu=generic -C target-feature=+simd128 -C linker=rust-lld" \
        cargo clippy --manifest-path crates/vectojs-core-rs/Cargo.toml \
        --release --target wasm32-unknown-unknown -- -D warnings

# Build the wasm, then run the core differential suite against it (skips itself if .wasm absent, so build first).
wasm-test: wasm
    @cd packages/core && bunx vitest run test/wasm

# --- e2e -----------------------------------------------------------------

# Browser e2e (HiDPI + text-projection: selection, RTL, DPR, zoom, fonts).
e2e:
    @bun run --filter '@vectojs/core' test:e2e

# --- Release -------------------------------------------------------------

# Add a changeset for the packages you touched (interactive).
changeset:
    @bun run changeset

# Apply pending changesets: bump versions + write CHANGELOGs.
version:
    @bun run version-packages

# Print current @vectojs/* versions for downstream bumping.
downstream-versions:
    @bun run scripts/downstream-versions.ts

# --- Maintenance ---------------------------------------------------------

# Report unused files / exports / dependencies (manual check, not a CI gate).
knip:
    @bun run knip

# Remove a finished carryctx worktree, e.g. `just wt-clean ctx-0017`.
wt-clean name:
    @git worktree remove --force .worktrees/{{name}} && git worktree prune
    @echo "removed .worktrees/{{name}}"
