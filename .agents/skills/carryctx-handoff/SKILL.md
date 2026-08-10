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

```bash
carryctx status --format markdown              # project, branch, HEAD, active tasks
carryctx agent current                         # who you are (needed for --agent)
carryctx task list --status in_progress        # tasks in flight
carryctx context --format markdown             # current task context, progress, next actions
carryctx checkpoint list                       # recent snapshots: done / remaining / blockers
carryctx decision list                         # decisions to cite, not restate
carryctx search "<topic>"                      # prior work a later phase must not rediscover
git status --porcelain && git log --oneline -5 # repo state for the table
```

### 2. Write the document

Name it timestamp-first: `YYYY-MM-DDTHHMMSSZ-slug.md` in the handoff directory
(`date -u +%Y-%m-%dT%H%M%SZ`). Use the `handoff-prompt` skill's TEMPLATE.md; if
it is not installed, use this structure:

- **§1 First commands** — carryctx-native, immediately executable:

  ```bash
  cd $WORKSPACE/<repo>
  carryctx agent current                 # expect: <you>
  carryctx resume                        # restores task, progress, next actions
  carryctx handoff list                  # pending requests (yours or incoming)
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
  --target <agent-name-or-role> \
  --task CTX-NNNN \
  --summary "Continue <work>: handoff doc at vectojs-docs/handoff-prompt/<timestamp>-<slug>.md"
```

`--target` accepts an agent ULID or role name (see `carryctx agent list`). The
summary carries the document path so the receiver can read it immediately.

### 4. Checkpoint before you go

```bash
carryctx checkpoint \
  --done "<what shipped this session>" \
  --remaining "<what the handoff doc covers>" \
  --blocker "none"
```

## Workflow B — taking over a handoff

1. **Find it**:

   ```bash

   carryctx handoff list
   carryctx handoff show HO-XXXX
   ```

2. **Read the document first** — the summary names its path. It states what not to redo, the traps, and the first commands.
3. **Resume and verify** — `carryctx resume`, claim the task (`carryctx task claim CTX-NNNN`, `carryctx task start CTX-NNNN`), then execute §1 in order and check the doc against reality: HEAD matches the table, dirty files match. If a stated fact no longer holds, reconcile the doc _before_ starting work.
4. **Execute in order**, recording as you go:

   ```bash
   carryctx progress todo "..."       # break tasks into tracked todos
   carryctx progress note "..."       # findings with file:line
   carryctx decision add --title "..." --task CTX-NNNN   # when a choice lands
   ```

5. **Close the loop** — accept the request (`carryctx handoff accept HO-XXXX`), and when the work is done: reconcile the survivors, archive the doc `.completed.md` (or `.superseded.md`), `carryctx task complete CTX-NNNN`, `carryctx checkpoint`, then write the next handoff if work remains.

## Do NOT

- **Do not restate the record** — checkpoint `done` text and decision bodies already exist in CarryCtx; the document cites IDs, or the doc grows into a postmortem nobody can trust.
- **Do not skip reconciliation** — finishing a handoff invalidates parts of the survivors; re-read and correct figures, gates, and traps before archiving.
- **Do not create a handoff request without a document** when the transfer needs measurements or ordering — `--summary` alone cannot carry a trap list.
- **Do not use `carryctx handoff` for routing when the work never leaves your own session** — the request registry is for transfers; the doc alone suffices for a same-agent next session.
