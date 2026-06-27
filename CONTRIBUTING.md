# Contributing to VectoUI

## The Engineering Workflow

We strictly follow a linear, heavily-gated Git workflow:
**Issue → Branch → Commit → PR → Review → Merge**

1. **Issue**: Every piece of work starts with an issue.
2. **Branch**: Create a branch off `main` with the format `feat/issue-123` or `fix/issue-123`.
3. **Commit**: We use Conventional Commits. Commits are enforced by `commitlint`. Example: `feat(core): add hit-testing engine`.
4. **Changeset**: Any change to `packages/*` needs a changeset — run `bun run changeset` and pick the bump (patch by default; minor for notable additive features). This drives versioning and the per-package changelog.
5. **PR**: Open a PR using the `gh` CLI. Include detailed descriptions and benchmarks if applicable.
6. **Review**: Ensure CI (Oxlint, Prettier, unit tests, build) passes.
7. **Merge**: PRs are merged via "Squash and Merge".

## Local checks before a PR

```bash
bun install
bun run test        # core + ui suites
bun run lint        # oxlint
bun run format      # prettier --write
```

## Coding Standards

- **Linter**: `oxlint` (Zero-config, extreme performance). No ESLint.
- **Formatter**: `prettier`.
- **Dependencies**: Analyzed by `knip`. No dead code allowed.
- **TypeScript**: Strict mode enabled.
- **Publishing**: `changesets` manages multi-package semantic versioning for `@vecto-ui/*`.

> Demos and the documentation site live in a separate repo,
> [vecto-website](https://github.com/Xuepoo/vecto-website); this repo is the engine only.
