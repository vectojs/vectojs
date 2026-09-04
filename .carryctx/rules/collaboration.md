# Rule: Collaboration and Workspace

## Scope

Applies to all work in `vectojs/` (the Bun monorepo of published `@vectojs/*` packages).

## Rules

1. CarryCtx is the durable coordination record. Use named sessions, task claim/start, declared scopes, `progress note`, `decision add --rationale`, and `checkpoint` — do not leave a task `in_progress` after its agent stops.
2. Subagents perform scoped implementation. The commander dispatches independent work via `carryctx worktree create`, reads results back from CarryCtx state and the diff, and owns integration.
3. Prefer one Git worktree per implementation task on `carryctx/{task_id}-{slug}` (`git.main_branch = main`). In a shared checkout, work only within explicitly disjoint scopes and preserve unrelated/untracked files.
4. Run Git and CarryCtx inside the `vectojs/` repository (or one of its worktrees); `$VECTOJS_WORKSPACE` itself is a plain container, not a Git repo (`AGENTS.md` §1).
5. For source analysis use `ctxctl` in this order: `outline`, targeted `symbol` or narrow `read`, then `deps`; compress verbose commands with `ctxctl exec`. Project config is `.ctxctl/config.toml`.
6. Use `$VECTOJS_WORKSPACE/recording/` for scratch in the current task (or `carryctx worktree` for isolation); do not drop temp files in package directories, `tmp/`, or system `/tmp`. `references/` clones are read-only — never edited or committed.
7. Avoid destructive `rm`/`rmdir`. Move obsolete files to a dated, collision-safe path under `.trash/` and record the move in CarryCtx.
8. Do not commit, merge, publish, install external code, or broaden task scope without explicit authority. Implementers hand off at `in_review`; a separate reviewer completes verified tasks.
