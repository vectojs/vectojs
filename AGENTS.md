# Vecto Monorepo Developer Agent Handbook

Welcome, Agent. This repository (`vectojs/`) contains the framework core packages for **VectoJS**, a high-performance, accessible, Zero-DOM canvas-based UI rendering engine.

---

## 1. Directory Structure & Architecture

This is a Bun monorepo. The codebase is modular and split into separate packages located under `packages/`:

```text
vectojs/
├── .carryctx/            # CarryCtx project config + rules/workflows/personas presets
├── .changeset/           # Changeset configs for package releases
├── .github/              # GitHub Actions CI/CD workflows
├── crates/
│   └── vectojs-core-rs/  # Rust wasm32 kernels for @vectojs/core (invisible perf backend; JS is the permanent fallback)
├── packages/
│   ├── core/             # Scene/Entity runtime, renderers (Canvas/SVG/WebGL/WebGPU), a11y projection
│   ├── text/             # Standalone text-shaping primitives (BiDi, Arabic, typography, MSDF, content grid)
│   ├── layout/           # Standalone layout engine (line breaking, exclusion flow, layout worker) — deps @vectojs/text
│   ├── math/             # Standalone spatial/physics math (SpatialHashGrid, SpringPhysics)
│   ├── animation/        # Standalone easing + tween/spring drivers — deps @vectojs/math
│   ├── ui/               # Reusable UI controls (Text, Button, Link, ScrollView) — no runtime deps
│   ├── markdown/         # Markdown + TeX-math entity (marked + MathJax) — deps @vectojs/ui, @vectojs/core
│   ├── three/            # WebGL / Three.js canvas mapping & raycasting adapters
│   ├── devtools/         # VMT inspector panel + headless model layer (audit, snapshot, pick)
│   ├── video-exporter/   # Deterministic fixed-step Chromium + FFmpeg H.264 export
│   └── graph3d/          # 3D force-directed graph visualization (instanced Three.js)
├── scripts/              # Build, CI, and benchmark helper scripts
├── Justfile              # Convenience recipes (downstream-versions, etc.)
├── tsconfig.json         # Workspace TS compilation config
└── package.json          # Workspace root defining dependencies & scripts
```

### Core Architecture Notes

- **Zero-DOM Rendering**: The engine renders everything directly to a Single `<canvas>`.
- **Accessibility Parity**: Interactive entities synchronize positioning to an absolute-positioned, transparent A11y DOM tree. Screen readers and automated testing agents (e.g. Playwright) interact with this A11y layer.
- **Modular Renderer Registration**: WebGL (`WebGLPointRenderer`) and WebGPU (`WebGPUParticleSystemManager`) are decoupled from the base `Scene` class. They statically register themselves upon loading `packages/core/src/index.ts` to keep basic execution lightweight and clean.
- **Decoupled engines**: The layout, text-shaping, math, and animation engines live in their own packages (`@vectojs/layout`, `@vectojs/text`, `@vectojs/math`, `@vectojs/animation`). `@vectojs/core` depends on and **re-exports** all of them, so its barrel and its `./layout`, `./text`, and `./renderer` subpaths remain backward compatible — code can keep importing everything from `@vectojs/core`. The dependency graph is acyclic: `text` and `math` are leaves; `layout → text`; `animation → math`; `core → {layout, text, math, animation}`. The `Entity`-based `MSDFTextEntity` / `SVGEntity` stay in `core` because they extend `Entity`.
- **Markdown is separate**: `Markdown` + `CodeBlock` (and the heavy `marked` + `mathjax-full` deps) live in `@vectojs/markdown`, which depends on `@vectojs/ui` (it composes ui components) and sits **above** `ui` in the graph — so `ui` no longer re-exports Markdown (that would be a cycle) and has zero runtime deps. Importing Markdown is `from '@vectojs/markdown'`, not `@vectojs/ui`.
- **Build order matters**: Because packages consume each other's built `dist/` for their `.d.ts` emit, build in dependency order: `math` + `text` → `layout` + `animation` → `core` → `ui` → `markdown` → `three`/`devtools`/… `bun run build` at the workspace root already does this. Vitest configs alias the sibling `@vectojs/*` packages to their `src/`, so tests run against source regardless of build state.

---

## 2. Engineering Standards & Quality Gates

Before declaring any change complete, you **must** run formatting, linting, and tests.

### Required Tooling

VectoJS is a modern greenfield project and standardizes on a fast, unified,
Rust/Go-based toolchain. Every tool is pinned as a `devDependency` in
`package.json` (**not** installed globally) and run through `bun`, so every
machine and CI runner uses the same locked version.

- **Runtime & package manager**: `bun` only — `bun.lock`, `packageManager: bun@…`, and `engines.bun` are the single source of truth. Do not use `node`, `npm`, `pnpm`, or `yarn` to run or install.
- **Formatter (authority)**: `oxfmt` (config `.oxfmtrc.json`) formats JS/TS/JSX/TSX/JSON. It is the **only** formatting gate — the pre-commit hook and CI both run it, so a commit is always CI-clean. Prettier has been removed.
- **Linter (authority)**: `oxlint` (config `oxlintrc.json`), `--deny-warnings` in CI. Do not invoke `eslint`.
- **Local dev layer**: `biome` (config `biome.json`) provides fast editor format + lint feedback. It is **advisory only** — it is not a commit or CI gate, because biome and oxfmt/oxlint intentionally disagree on a few trivia (e.g. empty `for(;;)` spacing) and two competing authorities over the same files is a footgun. `oxfmt`/`oxlint` always win.
- **Markdown**: `markdownlint-cli2` (config `.markdownlint-cli2.jsonc`).
- **GitHub Actions**: `actionlint` (Go binary; no npm package — CI runs the pinned `docker://rhysd/actionlint` image, local is optional).
- **Git hooks**: `lefthook` (`lefthook.yml`) replaces Husky + lint-staged + the Python `pre-commit`. `bun install` runs `lefthook install` via the `prepare` script. There is no `.husky/` directory in this repo.
- **Commit messages**: `commitlint` (conventional commits) on `commit-msg`.
- **Compiler**: TypeScript **7.x** everywhere; verify types with the package `build` (`tsc -p tsconfig.build.json`).
- **Unit testing**: Vitest via `bun run test`.
- **Rust / WASM** (`crates/vectojs-core-rs`): `rustfmt` + `cargo clippy --target wasm32-unknown-unknown -- -D warnings`. Toolchain is pinned via `rust-toolchain.toml` (`channel = "stable"`, `wasm32-unknown-unknown` target, `clippy`+`rustfmt` components). Never build with a bare `cargo build --target wasm32-unknown-unknown` — always use `crates/vectojs-core-rs/build.sh`, which sets `RUSTFLAGS` explicitly to avoid a global `~/.cargo/config.toml` leaking host-only flags (e.g. `-fuse-ld=mold`) into the wasm link. The compiled `.wasm` output is gitignored — built in CI, published to npm, never committed.

### Build & Verification Workflow

Run from the workspace root (all tools resolve to the locked local versions):

```bash
# Format (oxfmt) + all lint gates (oxlint, markdownlint, actionlint)
bun run format        # oxfmt --write
bun run check         # format:check + lint + lint:md + lint:actions

# Lint only (no warnings allowed)
bun run lint          # oxlint --deny-warnings

# Run unit tests
bun run test
```

The `lefthook` pre-commit hook auto-runs `oxfmt --write`, `oxlint --fix`, and
`markdownlint-cli2 --fix` on staged files, so formatting is applied for you at
commit time.

---

## 3. Agent Rules & Constraints

1. **Workspace Boundary**: Do not access locations outside the workspace; always remain within `/mnt/data/Workspace/Projects/vectojs` while working.
2. **Use locked local tooling**: All build/lint/format tools are pinned `devDependencies` run through `bun run <script>` or `bunx <tool>`, so everyone uses the same version. Do **not** rely on globally-installed tools or `bun add -g`; do not use `npx`. (`actionlint` is the sole exception — a Go binary with no npm package, enforced in CI via a pinned Docker image.)
3. **Preserve Documentation**: Retain all docstrings, comments, and typings unless they are directly contradicted by your code changes.
4. **Changesets**: Any public-facing package modification must be accompanied by a changeset. Run `changeset` to generate the version bump markdown.
5. **No Pollution**: Do not write temporary files or scratchpads into the package directories. Use the workspace root `tmp/` for scratch files.
6. **Task management via CarryCtx**: `.carryctx/` holds the project config plus `rules/`, `workflows/`, and `personas/` presets. Check `.carryctx/rules/formatting-and-linting.md` and `.carryctx/rules/wasm-crate-build.md` for domain-specific constraints before starting matching work, `.carryctx/workflows/publish-package.md` before cutting a release, and `.carryctx/personas/code-reviewer.md` when asked to review a PR. Use `carryctx progress todo/done/block/risk/note` and `carryctx checkpoint` to track multi-step work.
