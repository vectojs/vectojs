# CarryCtx

<!-- carryctx:v1 -->

[CarryCtx](https://github.com/Xuepoo/carryctx) is a local-first project context
engine for coordinating work across agents and sessions. It keeps durable
tasks, progress, decisions, checkpoints, and handoffs alongside the Git
workflow.

This directory contains VectoJS's versioned CarryCtx configuration:
`config.toml` defines project behavior, while `personas/`, `rules/`, and
`workflows/` provide repository-specific operating guidance. Runtime state is
stored separately in the Git common directory at
`<git-common-dir>/carryctx/state.sqlite`, shared by the primary checkout and
all worktrees. Version this directory, but never commit the database.

Use the repository's locked gates recorded in this configuration: `just check`
for formatting and linting, and `just verify` to include the unit-test suite.
Only the CarryCtx `post-commit` hook should be enabled here. Do not enable
`prepare-commit-msg`; its task-ID prefix conflicts with this repository's
Conventional Commit parser.
