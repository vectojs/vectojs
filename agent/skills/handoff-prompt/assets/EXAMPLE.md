# Handoff: dirty-tracked projection sync (acme#343)

Previous session finished the measurement pass (CTX-0198) and shipped it. Nothing
is half-finished. Your job is the **next** step, now backed by measurement rather
than by the issue's original framing: implement dirty-tracked projection sync in
`Scene.syncContentProjection`, then re-measure with the benchmark already on
`main`.

## First commands

```sh
cd ~/work/acme-canvas
git log --oneline -5                      # expect 02a14a73 or its squash on main
git status --porcelain
ctx resume --agent <your-harness>         # restore session record
gh issue view 343 --comments | tail -80
```

Read the CTX-0198 decision and the last comment on #343 before writing code.
Both contain the measurements below with full context; this file is the entry
point, not the record.

## Repo state

| repo          | HEAD       | branch | dirty                              |
| ------------- | ---------- | ------ | ---------------------------------- |
| `acme-canvas` | `02a14a73` | main   | 1 file — `README.md`, **not mine** |
| `acme-docs`   | `0948ac9`  | main   | clean, pushed                      |

`README.md` has an uncommitted one-line tagline added concurrently by someone
else; it was stashed and restored across a pull. **Leave it alone.**

`.changeset/` is empty. `@acme/canvas@1.30.0` is on npm (irreversible).

## The task

**Skip a resident block whose content has not changed, before
`getContentProjection()` is called.** Needs a per-entity content epoch/version
that `Scene` can compare cheaply.

Fix site: `src/tree/Scene.ts`, `syncContentProjection` at **4611**. The margin
gate is at **4638-4643** (deliberately hoisted above `getContentProjection()` —
do not move it), the line band at **4648**, and `projectionBoxVisible` at
**4483**.

### Why this and not the enum

The re-scoped issue implies `ContentProjectionMode: 'native' | 'hybrid' |
'onDemand' | 'never'` is the deliverable. **It is not the first commit**, because
measurement showed the cost basis has to change first. Shipping `'hybrid'` on
today's sync path would ship a supported mode costing 41.8-67.2x native idle.

### Measured evidence you do not need to re-derive

All from real headed Chrome 151 / Firefox 153. Final validated run
`20260804T141858Z-e33b87`, both engines `validation.ok=true`, 240.24 / 239.64 Hz
on a 240 Hz panel.

- **The unit of cost is the resident carrier per sync, ~13 us each.** Holding
  entity count at 1500, varying resident carriers: 24 → 0.700 ms, 186 →
  2.625 ms, 1501 → 19.345 ms. Cost tracks carriers, not entities.
- **It is paid for a no-op.** `getContentProjection` is called once per resident
  block per sync, and a sync with byte-identical `a11yRoot.textContent` still
  cost **17.875 ms**.
- **Caching the projection cannot fix it.** Memoizing saves 19% (20.275 →
  16.415 ms); the walk and the diff are the cost and happen around the build.
  This is why the fix must skip the block _before_ the call.
- **The target: 41x.** Simulated by removing unchanged off-band blocks from the
  scene graph while leaving their projected elements in the DOM: **19.455 →
  0.475 ms, 97.6% saved**, with `a11yTextLength` byte-identical at **170,670**.
  That is your success criterion.

### Two traps that cost this session real time

**`margin=Infinity` disables both engine gates.** `Number.isFinite(margin)` arms
the box test _and_ the line band, so an infinite margin runs
`getContentProjection()` unwindowed for every block — the O(total glyphs)
regression the comment at `Scene.ts:4632-4637` records as removed. The first
benchmark run measured that by accident and made hybrid look impossible
(100.765 ms/sync). Never make it a supported configuration.

**A wide finite margin is cheap only because its reach saturates.** It looks
like a bargain (1.8-3.6x native, +0.18 MB) but findable fraction decays as
1/documentHeight: 100% at 100 blocks, 46.3% at 400, 18.5% at 1000, **4.6% at
4000** — against native's 5.8%. It is "findable near the viewport", not
findable. Do not quote it as a cheap route to the capability.

**Memory is not the constraint**, contrary to the previous handoff's guess.
Projection-attributable heap at 10k blocks above a 21.44 MB floor: native
0.30 MB, windowed 0.48 MB, hybrid 7.04 MB, all-resident 67.07 MB. The
constraint is per-sync CPU.

## How to measure your change

The benchmark and both harness fixes are already on `main`:

```sh
cd benchmarks
RUN_TIMEOUT=300 RUN_EXTEND=900 ./run-browsers.sh hybrid-projection 8276 \
  --param blocks=100,1000,10000 --param trials=7 chrome firefox
```

- Timeouts are **env vars**, not flags; the runner's 60+180 default is not
  enough for 6 arms × 3 sizes.
- `--param arms=<one>` gives a single arm its own page load. **Required for any
  memory figure** — run together, heap baselines swing 7.8-13.9 MB and deltas go
  negative; one arm per load gives a 0.97 MB baseline with 0.00 MB spread.
- Cadence calibration lives at the start of `main()`. Do not move it: this
  bench's long synchronous syncs starve rAF, so calibrating at `reportResult()`
  measured 208.79 Hz on a 240 Hz panel and failed `validateEnvironment`.

**Confirm your gate fails against the pre-change behaviour before trusting it.**
That caught two real defects last session.

### Verification standard

Unit tests and lint are necessary and **not sufficient**. For anything touching
rendering, put a real document in a real browser and prefer a numeric probe over
a screenshot. The claims above were verified with unique per-block text
(`B<index>L<line>`), so `a11yRoot.textContent.includes('B57L0')` is a genuine
presence test.

Local gates: `npm run build`, `npm test -- src/tree`,
`npm run lint -- src/tree`, `npm run test:bench` (169 tests).

A core change needs a **changeset** (`minor` for new API, `patch` for a
behaviour fix).

## Suggested session boundary

Dirty-tracked sync plus its re-measurement is one session. Stop there and hand
off before touching `ContentProjectionMode` — the enum's design should be
revisited against the _new_ cost numbers, not this session's.

## Also open, deliberately not done

1. **`syncA11y` descends into every child unconditionally** (`Scene.ts:4459`),
   O(total entities)/frame, no viewport pruning. Dirty-tracking the projection
   tier will **not** fix it; it needs a subtree AABB on `Entity` that does not
   exist. Separate task.
2. **i18n gap, pre-existing, disclosed in acme-docs PR #24** — a `[!IMPORTANT]`
   paragraph about `r.globalAlpha = 0.5` being a silent no-op is absent from all
   six locales. The anchors gate cannot see it because admonitions are not
   headings.
3. **The component-sandbox gate visits exactly one page**, so the
   cache-bust-token staleness class recurs every release — 175 of 203
   occurrences were stale last time. Extending the gate to one localized page
   would close most of it.

## Unresolved anomaly (non-blocking)

Screenshot captures show canvases blank on a **multi-canvas** page while the
same page in an MCP-launched browser renders both, with backing stores verified
byte-identical. Ruled out: shared rAF loop, occluded-window backgrounding,
ResizeObserver clears. It is in the capture/compositing path, not the renderer,
and affects no performance number. Workaround: take visual confirmation from an
MCP-launched window.

Related trap: **a selection highlight over transparent carriers reads as
painted text.** Any automated check must count non-transparent pixels in the
backing store per canvas, or diff against a reference image.

## Tooling notes

- **`npx oxfmt` in a fresh worktree before `npm install` silently uses an
  unpinned version** that ignores the repo formatter config and rewrites every
  single quote. Always install first; prefer `./node_modules/.bin/oxfmt`.
- The `edit` tool re-indented unrelated deep-nested list blocks in a large
  Markdown file, turning a 6-issue lint baseline into 28. For a big structured
  edit, use a script that replaces exact line ranges and verify with
  `git diff -U0 <file> | grep '^@@'` that only your hunks appear.
- `ctx decision add` needs `--task CTX-NNNN` and takes
  `--context/--decision/--consequences` (**not** `--body`); `progress note` and
  `decision search` take their body/query **positionally**.
- `gh` needs `HTTPS_PROXY=$NETWORK_PROXY` on this machine. Wait on CI with
  `gh pr checks <N> --watch --interval 20`, never `sleep`.
- Background a long-running server with `pty_spawn`, not `nohup ... &` — the
  latter hangs the shell.

## Suggested skills

- `carryctx` — record progress notes and decisions as you go
- `browser-benchmarking` — running and interpreting the browser harness
- `a11y-verification` — real-DOM probes for the presence tests
