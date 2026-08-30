# Rule: Delivery Lifecycle

## Scope

Applies to planned changes that need a branch and pull request in `vectojs/`.

## Rules

1. Follow `Issue -> Branch -> Commit -> PR -> Review -> Merge` (`AGENTS.md` §3). Create or identify the GitHub Issue, then a CarryCtx task with concrete title/description/scopes/dependencies. Claim and start it with the acting agent identity.
2. Before the first commit, confirm `bunx carryctx hooks status`: this repo enables only the `post-commit` checkpoint hook. Do not enable `prepare-commit-msg` — its `[CTX-NNNN]` prefix is rejected by Commitlint (Conventional Commits, `commit-msg` via lefthook) and leaves HEAD unmoved with files still staged.
3. Use Conventional Commits (`feat|fix|docs|refactor|test|chore|perf|build|ci|style|revert`, lowercase subject, ≤100 chars). Include the task ID in a scope/body/trailer, not as a subject prefix.
4. Isolate the change in a CarryCtx worktree on the task-named branch. Read the applicable `.carryctx/rules/` and `.carryctx/workflows/` before editing. Keep commits coherent and reviewable.
5. Before considering any change complete, run the applicable gate: `just check` (format:check + oxlint --deny-warnings + markdownlint + actionlint) for JS/TS/docs/workflows, `just wasm-check` / `just wasm-test` for `crates/*`, and `just test` or `just test-pkg <pkg>` for logic changes. Prefer `just <recipe>` (`just --list`) over raw `bun run` so local and CI run the same locked versions.
6. A PR must state the outcome, affected packages/docs, security impact, validation evidence (commands run), dependencies, and follow-up. Link cross-repo PRs and their merge order where `vectojs-docs`/`vectojs-website` are involved.
7. Review is independent from implementation. The reviewer inspects the diff, contract, and reproducible evidence before acceptance. Branch protection requires exactly one check — `Test & Lint` (`strict: true`) — but a failed `wasm` job still reports `UNSTABLE`; diagnose by failed step, not conclusion.
8. Merge only after required review findings and CI failures are resolved and the diff has been independently inspected. Merge from the primary checkout (`gh pr merge` from a worktree reports `main is already used by worktree` after the remote merge has already succeeded).
9. After merge, close the Issue, record the merge commit and final evidence in a `carryctx checkpoint`, complete progress items and the task, and remove only its clean worktree. End the session with a final checkpoint; do not leave an active session without a recorded blocker.
10. Public package changes require a changeset (`just changeset`); do not hand-edit versions without `changeset version`. See `.carryctx/workflows/publish-package.md` for the tag-triggered publish path (`@vectojs/<pkg>@<version>`, one tag per push).
