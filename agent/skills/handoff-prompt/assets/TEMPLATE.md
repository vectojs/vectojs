# Handoff — [brief title] (YYYY-MM-DDTHHMMSZ)

[One paragraph context: what was just done, what remains, and why this handoff exists]

## Project conventions (fill once per project, then delete)

- HANDOFF_DIR: `path/to/handoff-prompt/`
- ARCHIVE_DIR: `path/to/trash/handoff-prompt/`
- PROJECT_DIR: `path/to/project`
- REPOS: `[repos this handoff touches]`
- FIRST_CMDS: `[commands that verify repo state, e.g. git log --oneline -5]`
- TEST_CMDS: `[exact test commands]`
- LINT_CMDS: `[exact lint/format commands]`
- RECORD_CMDS: `[session-record commands, if any — progress notes, decisions, checkpoints]`

## 0. [Optional: Order/Priority section if multiple clusters]

[If there are multiple tasks, explain which to do first and why, with evidence]

## 1. First commands

```bash
cd $PROJECT_DIR
git log --oneline -5                      # expect <commit> or its squash on main
[other verification commands]
```text

[Then explain next steps based on task type]

```bash
[task setup commands: branch/worktree creation, install, build]
```text

## 2. Repo state

| Repo     | HEAD      | Dirty           | Remote               | Notes               |
| -------- | --------- | --------------- | -------------------- | ------------------- |
| `[repo]` | `xxxxxxx` | clean / N files | in sync / **pushed** | [state description] |

[Explain any dirty state in detail:]

```text
M path/to/file.ts
?? new/file.ts
```text

[Describe what each change is, why it's uncommitted, and what to do with it]

**Unreleased changesets**: [list them, or "none"]

**Active worktrees**: [list from `git worktree list`, or note if stale ones exist]

**Published versions**: [if relevant]

## 3. What is already done (do not redo)

[Everything completed in the previous session that must not be reimplemented or re-audited]

**[Feature/Fix name]** — [concise description with measurements]

- Key implementation detail
- Measured outcome (with numbers)
- File locations: `path/to/file.ts`
- Tests: unit / e2e / sabotage
- Status: committed / uncommitted / released

[Repeat for each completed item]

## 4. Task [N] — [primary task title] [mark as "start here" if it's the first]

**Scope**: [what needs to be done]

**Location**: `path/to/file.ts`

**Evidence**: [measurements or findings that inform the approach]

**Approach**: [step-by-step, with rationale]

1. [Step 1 with command if applicable]

   ```bash
   command here
   ```

1. [Step 2]

2. [Step 3]

**Verification**:

- [ ] Lint + format pass
- [ ] Unit tests written and pass
- [ ] E2e tests pass (if applicable)
- [ ] Changeset added (if public API)
- [ ] Sabotage verification (for new features)

**Blocker/Trap**: [any known issues or things to avoid]

## 5. Task [N+1] — [secondary task]

[Same structure as Task N]

## 6. [Optional: Decision framework or constraints]

[If there are choices to make, provide the decision criteria]

## 7. Verification standard

For any task marked complete:

1. **Code quality**: [exact lint + format commands]
2. **Tests**: [exact unit/e2e commands]
3. **Changesets**: created if public API modified
4. **Documentation**: updated if API changed
5. **Sabotage verification**: for new features, prove the gate works
6. **Session record**: progress notes + decisions recorded

## 8. What NOT to do

- **Do not [X]** — [why, with evidence or citation]
- **Do not [Y]** — [why]

## 9. Known traps from this session

[List anything that cost real time and should be avoided]

### Trap 1: [brief name]

**Symptom**: [what it looks like]

**Cause**: [root cause]

**Fix**: [how to avoid or resolve]

**Evidence**: [measurement or citation]

---

## Template notes (delete this section in actual handoffs)

### Style guidelines

1. **Be specific with measurements**: actual numbers, not "it's faster"
2. **Cite file:line locations**: `Scene.ts:3905-3907`, not "somewhere in Scene"
3. **Write executable commands**: full command blocks, not "run the tests"
4. **Explain causality**: why X causes Y, not just that Y happened
5. **Mark inferred vs measured**: if you didn't measure it, say "INFERRED"
6. **Keep "do not redo" exhaustive**: every completed item, so it's not redone
7. **Record traps that cost time**: so the next agent doesn't pay again

### Section ordering

- **§0 (optional)**: only if multiple clusters need prioritization
- **§1**: always "First commands" — immediately executable
- **§2**: always "Repo state" — table format, dirty files listed
- **§3**: always "What is already done" — prevents rework
- **§4-N**: tasks in execution order, with "start here" on the first
- **Last sections**: verification standard, what NOT to do, known traps

### Multiple live files

Sequential by default; parallel only when the work genuinely does not overlap.
**Ordered phases** get a phase number in the filename (`-phase1-`), a shared
timestamp so `ls` sorts in execution order, a pointer to the next file, and a
prerequisite check on every phase after the first. **Independent tasks** are
work with no ordering between items and no shared files — a locale translation
pass, a docs sweep, per-package cleanups — named by subject, each declaring that
it is independent and what it must not touch. Either way, **one subject per
file** — a file mixing a defect fix with a refactor is not a phase. Ordered
phases are normally taken one per session; independent tasks with no file
overlap can run at once in parallel worktrees. The test is **file overlap and
ordering, not subject matter**. Judge the split per case — it is not a fixed
limit. Prefer the fewest files the work honestly divides into.

### Reconcile the survivors, then archive

**Finishing one handoff makes parts of the others untrue.** Before archiving,
re-read every file still live and correct what your session changed: figures a
later phase quotes as fixed, prerequisite checks naming PRs that have since
merged, new API or invariants it must not rediscover, traps that cost you real
time, and orderings your work created or discharged. Keep the edits small and
factual. A survivor that needs rewriting wholesale is a new handoff — archive it
`.superseded.md` instead. Say what you found either way; silence cannot be told
apart from not having looked. This is the difference between a relay and a pile
of independently rotting documents.

### Archiving completed handoffs

```bash
mv handoff-prompt/old-handoff.md \
   {ARCHIVE_DIR}/old-handoff.completed.md
```text

The `.completed.md` suffix marks it done without losing the original timestamp
(`.superseded.md` if rewritten rather than finished).
