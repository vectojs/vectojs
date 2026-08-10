---
description: "Write a structured handoff prompt document so a fresh agent session can pick up unfinished work without re-diagnosis. Use when ending a session mid-work, when the context window is approaching its ceiling, or when the next session must continue the work without the current history."
---
Write a handoff prompt: the compressed, actionable record of what the next agent needs to act — first commands, repo state, what is done (so it is not redone), remaining tasks with `file:line` locations and measured evidence, how to verify success, and the traps that cost this session time.

This is **not** a summary of what was done. Do not duplicate content already captured in other artifacts (specs, plans, ADRs, issues, commits, diffs) — reference them by path instead. Redact sensitive information: API keys, passwords, personally identifiable information.

If the user passed arguments, treat them as a description of what the next session will focus on and tailor the document accordingly.

Include a **"Suggested skills"** section listing skills the next agent should invoke.

## Destination

The handoff lives in a project directory (default `handoff-prompt/` in the project's docs repo; ask the user if unsure). Completed handoffs are archived to a trash/archive directory with a `.completed.md` suffix (`.superseded.md` if rewritten rather than finished). Keep exactly one live file unless the work splits into sequenced phases or independent tasks — an unordered pile is the actual failure mode, not plurality.

## Writing workflow

1. **Name the file timestamp-first**: `YYYY-MM-DDTHHMMSSZ-slug.md` (generate with `date -u +%Y-%m-%dT%H%M%SZ`).
2. **Copy `assets/TEMPLATE.md`** into the handoff directory under that name and fill every section:
   - Fill the **Project conventions** block first (handoff dir, archive dir, exact verify/record commands) — this is what makes the template project-agnostic.
   - §1 First commands: immediately executable, no decisions needed.
   - §2 Repo state: table with HEAD / dirty / remote for every touched repo.
   - §3 What is already done: exhaustive, so it is never redone.
   - §4-N Tasks: execution order, measurements, `file:line` locations.
   - Last sections: verification standard, constraints, traps that cost time.
3. **Be specific**:
   - ✅ `Scene.ts:3905-3907` — not "somewhere in Scene"
   - ✅ `63.25 → 27.38 ms` — not "faster"
   - ✅ `git log --oneline -5` — not "check the log"
   - ✅ `INFERRED` — if you did not measure it
4. **Sequential by default; parallel only when the work genuinely does not overlap** — most handoffs are picked up one at a time. Multiple live files exist only when the work honestly splits, and then into one of two shapes:
   - **Ordered phases**: phase number in the filename (`-phase1-`), all phases share one timestamp so `ls` sorts in execution order; each file names its successor and says whether it must not be started in the same session; every phase after the first opens with a **prerequisite check** — commands proving the earlier phase finished, and where to go if it fails; one subject per file.
   - **Independent tasks**: work with no ordering between items and no shared files — a locale translation pass, a docs sweep, per-package cleanups. Name these by subject, open with a line declaring independence and what the file must not touch. Several can run at once, in separate worktrees.
   - The test is **file overlap and ordering, not subject matter**. Two handoffs editing the same file are sequential even if unrelated; two editing different files are parallel even if both are "i18n".
   - Judge the split per case — it is not a fixed limit. Prefer the fewest files the work honestly divides into.
5. **Reconcile the survivors, then archive**: finishing a handoff invalidates parts of the ones still live. Before archiving, re-read every live file and correct what the work changed — prerequisite checks naming merged PRs, figures the finished work moved, new API/invariants the survivor must not rediscover, traps worth carrying, orderings that no longer hold. Keep edits small and factual; a survivor needing wholesale rewrite is a new handoff (archive it `.superseded.md`). Say what you found either way — "reconciled phases 2 and 3, no change needed" is a real outcome.
6. **Archive the previous handoff**: `mv live-handoff.md {archive-dir}/live-handoff.completed.md`.
7. **Commit** if the destination is version-controlled, with a message like `docs(handoff): <what's being handed off>`.

## Taking over a handoff

When a session starts and a live handoff exists:

1. **Determine what is live**: list the files in the handoff directory. One file — read it. Several — read them all and decide the order from their phases (numbered filenames) or independence declarations, **before touching code**. Do not guess which is current.
2. **Read the handoff first** — it states what not to redo, the traps, and the exact first commands.
3. **Execute §1 First commands in order, then verify the doc against reality**: `HEAD` matches the table, dirty files match the listing. If any stated fact does not hold (a PR already merged, a figure moved), reconcile the handoff to the new reality _before_ starting work — the next agent should never rediscover drift.
4. Follow the task order; "start here" marks the first task.
5. **Record your work as you go** using the session-record commands from the Project conventions block (`RECORD_CMDS`) — progress notes with `file:line`, decisions with rationale. The handoff stays lean because the record holds the detail.
6. When done: **reconcile the survivors, archive** this handoff `.completed.md`, and write the next one if work remains.

## Common mistakes

- ❌ **Multiple live handoffs** — ambiguity, costs the next agent time. Keep exactly one; archive the rest.
- ❌ **"Run the tests"** — too vague. Give the exact command.
- ❌ **"It's faster now"** — unmeasured claim. Give before/after numbers.
- ❌ **No file:line locations** — the next agent re-diagnoses.
- ❌ **Handoff doubles as postmortem** — grows to 500 lines. Measurements and rationale go to the session record; the handoff stays actionable.
- ❌ **Archive and go** — the survivors quote figures this session just moved. Reconcile first.
