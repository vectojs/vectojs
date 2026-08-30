# CarryCtx

<!-- carryctx:v1 -->

This directory contains versioned CarryCtx project configuration.
Runtime state is stored in the repository's Git common directory
(`<git-common-dir>/carryctx/state.sqlite`, shared across the primary
checkout and all worktrees), not here. Version this directory; never
commit the database.

This configuration follows the explicit CarryCtx layout used by
`bitty-docs/.carryctx`: project-local verification, role personas, rules, and
workflows. Its commands are the repository's real gates: `just check` runs
format, lint, Markdown, shell, and action checks; `just verify` adds the full
unit-test suite. The rules also document the `oxfmt`/`oxlint` authorities,
`lefthook` and `commitlint` posture, WASM fallback contract, docs provenance,
and the `Test & Lint`-only required CI check.

Runtime state remains outside this directory in the Git common directory. Do
not commit the CarryCtx database or enable `prepare-commit-msg`: CarryCtx's
task-ID prefix conflicts with this repository's Conventional Commit parser.
