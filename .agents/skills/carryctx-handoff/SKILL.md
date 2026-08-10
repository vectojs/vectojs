---
name: carryctx-handoff
description: Produce a handoff-prompt document from CarryCtx state and route it with the `carryctx handoff` subcommand. Use when ending a session with unfinished work, when a session must continue without the current history, or when work transfers to another agent or role — turns tasks, checkpoints, decisions, and progress into an actionable handoff document, and registers a handoff request the next agent can accept.
license: MIT
metadata:
  author: Xuepoo
  version: "0.1.0"
---

# CarryCtx Handoff Skill

Bridge CarryCtx state into a **handoff-prompt document** and route it through
`carryctx handoff`. The division of labour:

- **CarryCtx is the record** — queryable tasks, checkpoints, decisions, progress, events.
- **The handoff document is the entry point** — first commands, task order, verification standard, traps. It points into CarryCtx by ID and does not restate what the record holds.

## When to use

- Session is ending with unfinished work, and the next session (or a different agent) must continue without this history.
- Work transfers between agents or roles (`opencode` → `claude-code`, or a task handed to a reviewer).
- Context is approaching the token ceiling and must be compressed into an actionable form.

Do **not** use for a single quick task finished in one session, and do **not** write a document for a transfer that `carryctx handoff create` alone can carry — the doc pays for itself when the next agent needs measurements, ordering, or traps.

## Prerequisites

1. CarryCtx initialized in the project: `carryctx init` (config at `.carryctx/config.toml`).
2. Handoff directory in the project's docs repo (default `handoff-prompt/`, per the generic `handoff-prompt` skill — install it for the canonical TEMPLATE.md and the serial/parallel and reconciliation rules).

## Workflow A — writing a handoff (session end)

### 1. Gather state from CarryCtx

`--agent` is **required on every call that writes state**, and in some builds on
`agent current` too, so pass it everywhere rather than discovering the exception:

```bash
A=<you>                                            # kiro | claude-code | codex | omp | opencode
carryctx agent current --agent $A                  # confirm identity before writing anything
carryctx status --agent $A --format markdown       # project, branch, HEAD, active tasks
carryctx task list --agent $A --status in_progress  # tasks in flight
carryctx context --agent $A                        # current task context, progress, next actions
carryctx checkpoint list --agent $A                # recent snapshots: done / remaining / blockers
carryctx decision list --agent $A                  # decisions to cite, not restate
carryctx search "<topic>" --agent $A               # prior work a later phase must not rediscover
git status --porcelain && git log --oneline -5     # repo state for the table
```

Two read-path caveats, measured on 0.5.0: `--format markdown` returns **JSON** for
`context` and `handoff show`, and `context --task CTX-NNNN` reports `decisions: []`
even when a decision carries that exact `task_id` — so gather decisions with
`decision list` / `decision search`, not from the context dump.

### 2. Write the document

Name it timestamp-first: `YYYY-MM-DDTHHMMSSZ-slug.md` in the handoff directory
(`date -u +%Y-%m-%dT%H%M%SZ`). Use the `handoff-prompt` skill's TEMPLATE.md; if
it is not installed, use this structure:

- **§1 First commands** — carryctx-native, immediately executable:

  ```bash
  cd $WORKSPACE/<repo>
  carryctx agent current --agent <you>   # expect: <you>
  carryctx resume --agent <you>          # restores task, progress, next actions
  carryctx handoff list --agent <you>    # pending requests (yours or incoming)
  git log --oneline -5                   # expect <commit> or its squash on main
  ```

- **§2 Repo state** — table: repo / HEAD / dirty / remote; explain dirty files; unreleased changesets; worktrees (`git worktree list`).
- **§3 What is already done** — from checkpoint `done` fields and progress notes. **Cite checkpoint/task IDs instead of restating**: "recorded in CTX-0197 checkpoint `01KZ...`".
- **§4-N Tasks** — execution order, `file:line` locations, measured evidence. Reference decisions: "see `carryctx decision search 'hybrid projection'` — DEC-0012 explains why X over Y".
- **Last sections** — verification standard (exact commands), what NOT to do, traps from this session (with symptom/cause/fix/evidence).

Be specific: `Scene.ts:3905-3907`, `63.25 → 27.38 ms`, `INFERRED` when not measured. One subject per file; sequenced phases and independent tasks follow the `handoff-prompt` skill's rules.

### 3. Route it with `carryctx handoff`

```bash
carryctx handoff create \
  --agent <you> \
  --target <agent-name-ULID-or-role> \
  --task CTX-NNNN \
  --summary "Continue <work>: doc at vectojs-docs/handoff-prompt/<timestamp>-<slug>.md — read it first. INDEPENDENT of CTX-MMMM / FOLLOWS CTX-MMMM."
```

`--target` accepts an agent name, ULID, or role (`carryctx agent list`); name and
role resolution landed in **0.5.0**, and an unresolvable one now reports
`Target agent '…' not found` rather than a raw FK error.

**`--task` is mandatory in practice** despite reading as optional — omitting it
fails `VALIDATION_FAILED: No task specified`. So create the task _before_ routing,
one per document. `--dry-run` parses flags but does **not** validate the target.

Put the document path **and** the ordering claim in `--summary`: it is the only text
`handoff list` shows, and a receiver deciding what to pick up next needs to know
whether two open requests may run in parallel. Keep it consistent with what the
document itself says.

The record's `completed_work`, `remaining_work`, `blockers`, `risks`, `next_steps`
and `changed_files` are **not settable by `create`** and are **not inherited** from a
checkpoint carrying exactly those values (verified 0.5.0). Treat the request as
routing metadata — target, task, HEAD, branch, summary — and keep all substance in
the document and in progress notes.

### 4. Checkpoint before you go

```bash
carryctx checkpoint \
  --agent <you> \
  --task CTX-NNNN \
  --done "<what shipped this session>" \
  --remaining "<what the handoff doc covers>" \
  --blocker "none"
```

Checkpoint **before** the branch is merged away: `checkpoints.branch` records HEAD at
checkpoint time, so checkpointing only after a squash-merge records `main` and loses
the feature branch. Then close or block every task you started — a task left
`in_progress` across a session boundary is indistinguishable from one being actively
worked, which makes `task list --status in_progress` useless as a startup signal.

## Workflow B — taking over a handoff

1. **Find it**:

   ```bash
   carryctx handoff list --agent <you>
   carryctx handoff show HO-XXXX --agent <you>
   ```

   More than one open request is normal. Their summaries say whether they are ordered
   or independent; if two are independent, they can run in parallel worktrees.
2. **Read the document first** — the summary names its path. It states what not to redo, the traps, and the first commands.
3. **Accept, then claim explicitly**:

   ```bash
   carryctx handoff accept HO-XXXX --agent <you>
   carryctx task claim CTX-NNNN --agent <you>
   carryctx task start CTX-NNNN --agent <you>   # idempotent since 0.5.0
   ```

   **Do not rely on `accept --claim-task`.** Measured on 0.5.0: it marks the handoff
   `accepted` but leaves the task's `owner_agent_id` null and its status `ready`, so
   the claim silently does not happen.
4. **Verify the document against reality before writing code.** Run
   `carryctx resume --agent <you>`, then execute its §1 in order: HEAD matches the
   table, dirty files match, versions match. If a stated fact no longer holds,
   reconcile the doc _first_ — a handoff written a day earlier can be wrong about what
   has since merged.
5. **Execute in order**, recording as you go:

   ```bash
   carryctx progress todo "..." --agent <you>       # tracked todos
   carryctx progress note "..." --agent <you>       # findings with file:line
   carryctx decision add --agent <you> --task CTX-NNNN \
     --title "..." --rationale "..."                # when a choice lands
   ```

   `--rationale` is the field worth searching and it exists only since 0.4.5; a
   decision without it stores the "why" nowhere.
6. **Close the loop** — reconcile the surviving documents, archive this one
   `.completed.md` (or `.superseded.md` if you rewrote rather than finished it), then
   `carryctx task complete CTX-NNNN --agent <you>`, `carryctx checkpoint`, and write
   the next handoff if work remains. Saying "reconciled the survivors, no change
   needed" is a real outcome; silence cannot be told apart from not having looked.

## Do NOT

- **Do not restate the record** — checkpoint `done` text and decision bodies already exist in CarryCtx; the document cites IDs, or the doc grows into a postmortem nobody can trust.
- **Do not skip reconciliation** — finishing a handoff invalidates parts of the survivors; re-read and correct figures, gates, and traps before archiving.
- **Do not create a handoff request without a document** when the transfer needs measurements or ordering — `--summary` alone cannot carry a trap list, and the record's structured fields are not writable by `create`.
- **Do not leave a document unrouted, even when the next session is you.** Target yourself: `handoff list` is what a session actually runs at startup, and an unrouted document is discoverable only by someone who already knows to look in the directory. Measured 2026-08-10 in `vectojs`: `handoff list` returned `[]` while two live documents sat in `handoff-prompt/`.
- **Do not assume one live document.** Several are fine when each declares whether it is an ordered phase or independent; the failure mode is ambiguity, not plurality. One subject per file — a file mixing a defect fix with a refactor is not a phase.
