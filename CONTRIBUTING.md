# Contributing to VectoUI

## The Engineering Workflow

We strictly follow a linear, heavily-gated Git workflow:
**Issue → Branch → Commit → PR → Review → Merge**

1. **Issue**: Every piece of work starts with an issue.
2. **Branch**: Create a branch off `main` with the format `feat/issue-123` or `fix/issue-123`.
3. **Commit**: We use Conventional Commits. Commits are enforced by `commitlint`. Example: `feat(core): add hit-testing engine`.
4. **PR**: Open a PR using the `gh` CLI. Include detailed descriptions and benchmarks if applicable.
5. **Review**: Ensure all GitHub Actions (Oxlint, Prettier, Knip) pass.
6. **Merge**: PRs are merged via "Squash and Merge".

## Coding Standards

- **Linter**: `oxlint` (Zero-config, extreme performance). No ESLint.
- **Formatter**: `prettier`.
- **Dependencies**: Analyzed by `knip`. No dead code allowed.
- **TypeScript**: Strict mode enabled.
- **Publishing**: `changesets` is used to manage multi-package semantic versioning for `@vecto/*`.
