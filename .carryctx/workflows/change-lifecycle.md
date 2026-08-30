# Workflow: Deliver a Tracked Repository Change

## Trigger

Use for a planned code, benchmark, tooling, or repository-maintenance change
that needs a branch and pull request.

## Preconditions

- Run CarryCtx from this repository or one of its linked worktrees; state is
  shared through the Git common directory.
- Check `carryctx hooks status` before the first commit. This repository uses
  only the CarryCtx `post-commit` hook. Do not enable `prepare-commit-msg`:
  its `[CTX-NNNN]` prefix is incompatible with the Conventional Commit parser.

## Steps (translate into `carryctx progress todo` items, then execute sequentially)

1. **Create the durable work record.** Create or identify the GitHub issue,
   then create a CarryCtx task with a concrete title, description, scopes, and
   dependencies. Claim and start it with the acting agent identity.
2. **Plan the verification.** Add progress items for investigation,
   implementation, and every relevant quality gate. Record any non-obvious
   choice with `carryctx decision add --rationale` before implementing it.
3. **Isolate the change.** Create a CarryCtx worktree on a task-named branch.
   Read the applicable rules and workflow before editing. Keep unrelated
   changes in their existing worktrees.
4. **Implement with durable progress.** Add findings, risks, and completed
   steps as progress records. Before committing, run the focused checks and
   inspect the diff. Use a Conventional Commit message; include the task ID in
   a scope, body, or trailer rather than prepending it to the subject.
5. **Capture the commit.** The CarryCtx `post-commit` hook records the active
   task's commit SHA in a checkpoint. Confirm the checkpoint exists; if the
   hook is unavailable, create an explicit checkpoint with the commit SHA,
   done work, remaining work, and blockers.
6. **Review and merge.** Push the branch, open a PR linked to the issue, and
   move the task to review. Independently inspect the diff and wait for every
   required CI check to pass. Checkpoint from the task worktree immediately
   before merging, then merge from the primary checkout and fast-forward it.
7. **Close and clean up.** Record the merge commit and verification in the
   task, complete all progress items, complete the task, and remove only its
   clean CarryCtx worktree. End the session with a final checkpoint; do not
   leave an active task or session without a recorded blocker.

## Do NOT

- Do not use CarryCtx hooks as a replacement for Lefthook or CI; they record
  lifecycle state and do not validate source code.
- Do not force-remove a dirty worktree or close a task before its PR is merged
  and verified.
- Do not enable the default CarryCtx `prepare-commit-msg` hook unless the
  repository's Commitlint parser is explicitly updated to accept its prefix.
