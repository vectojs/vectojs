# Vecto Monorepo Developer Agent Handbook

Welcome, Agent. This repository (`vectojs/`) contains the framework core packages for **VectoJS**, a high-performance, accessible, Zero-DOM canvas-based UI rendering engine.

---

## 1. Directory Structure & Architecture

This is a Bun monorepo. The codebase is modular and split into separate packages located under `packages/`:

```
vectojs/
├── .changeset/           # Changeset configs for package releases
├── .github/              # GitHub Actions CI/CD workflows
├── .husky/               # Git hook handlers (Husky)
├── packages/
│   ├── core/             # Mathematical core, layout engine, and renderers (WebGL/WebGPU)
│   ├── ui/               # Reusable UI controls (Text, Button, Link, ScrollView)
│   ├── three/            # WebGL / Three.js canvas mapping & raycasting adapters
│   ├── devtools/         # VMT inspector panel + headless model layer (audit, snapshot, pick)
│   ├── video-exporter/   # Deterministic fixed-step Chromium + FFmpeg H.264 export
│   └── graph3d/          # 3D force-directed graph visualization (instanced Three.js)
├── scripts/              # Build, CI, and benchmark helper scripts
├── Justfile              # Convenience recipes (downstream-versions, etc.)
├── tsconfig.json         # Workspace TS compilation config
└── package.json          # Workspace root defining dependencies & scripts
```

### Core Architecture Notes:

- **Zero-DOM Rendering**: The engine renders everything directly to a Single `<canvas>`.
- **Accessibility Parity**: Interactive entities synchronize positioning to an absolute-positioned, transparent A11y DOM tree. Screen readers and automated testing agents (e.g. Playwright) interact with this A11y layer.
- **Modular Renderer Registration**: WebGL (`WebGLPointRenderer`) and WebGPU (`WebGPUParticleSystemManager`) are decoupled from the base `Scene` class. They statically register themselves upon loading `packages/core/src/index.ts` to keep basic execution lightweight and clean.

---

## 2. Engineering Standards & Quality Gates

Before declaring any change complete, you **must** run formatting, linting, and tests.

### Required Tooling:

- **Package Manager**: Use `bun` (and `bun.lock` format).
- **Linter**: Use `oxlint` (configured via `oxlintrc.json`). Do not invoke `eslint`.
- **Formatter**: Prettier is strictly enforced.
- **Compiler**: Verify types with `tsc` compile.
- **Unit Testing**: Run Vitest-based suite via `bun run test`.

### Build & Verification Workflow:

Always run the following commands sequentially inside the modified package(s) or from the workspace root:

```bash
# Format codebase
prettier --write .

# Lint check (no warnings allowed)
oxlint --deny-warnings

# Run unit tests
bun run test
```

---

## 3. Agent Rules & Constraints

1. **Workspace Boundary**: Do not access locations outside the workspace; always remain within `/mnt/data/Workspace/Projects/vectojs` while working.
2. **Invoke Binaries Directly**: Always run globally installed tools (`prettier`, `oxlint`, `changeset`) directly. Do **not** prefix with `bunx` or `npx`.
3. **Preserve Documentation**: Retain all docstrings, comments, and typings unless they are directly contradicted by your code changes.
4. **Changesets**: Any public-facing package modification must be accompanied by a changeset. Run `changeset` to generate the version bump markdown.
5. **No Pollution**: Do not write temporary files or scratchpads into the package directories. Use the workspace root `tmp/` for scratch files.
