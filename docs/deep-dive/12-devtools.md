---
title: "12 — DevTools — Runtime Introspection & Auditing"
description: "Why a canvas has no Elements panel, how the VMT inspector replaces it in state space, and the headless model layer — picking, geometry readouts, audits, snapshots, hit explanation, dirty-frame attribution, and the bridge/plugin protocol."
order: 32
---

# 12 — DevTools — Runtime Introspection & Auditing

> A `<canvas>` has no Elements panel. The browser can show you pixels and DOM mirrors, but not the Virtual Math Tree that decided which pixels to paint and which mirrors to keep. DevTools is that panel — a state-space inspector so debugging a VectoJS scene stays in numbers, not screenshots.

- **What you'll learn**: why VectoJS needs its own inspector, how the panel stays out of the inspected scene's way, and every pure function in the headless model layer — tree model, picking, entity/a11y/text readouts, seven geometry layers, layout/a11y/text/selection/GPU/accelerator audits, snapshots/diffs, hit explanation, event trace, dirty-frame diagnosis, and the JSON-RPC bridge with its plugin protocol.
- **What you won't**: how `Scene` schedules frames (boss 06), how a renderer paints them (boss 07), or how WASM accelerates them (boss 08). This doc is the tooling that _reads_ those subsystems without mutating them.

## 1. Why numbers before screenshots

A screenshot answers "something is wrong." A number answers _which entity_ is wrong, _by how many pixels_, and _why the engine thought it was right_. The whole DevTools package (`packages/devtools/src/`) is organized around that ladder:

1. **Locate** — which entity owns a pixel (`pickInScene`) and where it sits in the tree (`buildTreeModel`, `entityPath`).
2. **Measure** — its geometry, transform, and world bounds in world units (`inspectEntity`) and every box it carries that can diverge (`highlightGeometry`).
3. **Explain** — why the engine picked that entity and not the one you expected (`explainHitTest`), and where the browser event actually arrived (`createEventTrace`).
4. **Audit** — whether any entity violates a structural invariant while looking fine to the eye (`auditScene`, `auditA11y`, `auditTextShaping`).
5. **Diff** — what changed between two states, addressed by stable paths rather than random ids (`captureSnapshot` / `diffSnapshots`).
6. **Attribute** — why an `onDemand` scene never idles and what the render loop really costs (`diagnoseDirty`, `Scene.frameStats` at `packages/core/src/tree/Scene.ts:3515`).

Each rung returns plain data, not pixels. That makes every check a CI gate: `expect(auditScene(scene)).toEqual([])` (`vectojs-docs/content/reference/devtools-audit.md:12`).

## 2. Two surfaces, one model layer

| Surface                                     | Entry                                                                             | Renders                                                                                                            | Needs `destroy()`                                                                                                  | Ships to production                                                                        |
| ------------------------------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| **Panel** (`@vectojs/devtools`)             | `attachDevtools(scene)` → `DevtoolsPanel` at `packages/devtools/src/panel.ts:140` | Its own `Scene` docked to the viewport edge, `contentProjection: false`, `renderMode: 'onDemand'` (`panel.ts:299`) | Yes — `destroy()` tears down timers, listeners, highlight, panel scene, and container (`panel.ts:1272`)            | Never — `if (import.meta.env.DEV)` guard (`vectojs-docs/content/reference/devtools.md:51`) |
| **Headless** (`@vectojs/devtools/headless`) | Pure functions re-exported from `packages/devtools/src/headless.ts:1`             | Nothing                                                                                                            | Only `EventTrace` attaches document listeners (`packages/devtools/src/eventTrace.ts:85`) and must be `destroy()`'d | Yes — no panel, no `@vectojs/ui` dep, usable in Vitest/Node/agents                         |

The panel _calls_ the headless layer; it does not duplicate it. The headless layer carries ~60 exported pure functions — the larger and more useful half (`vectojs-docs/content/reference/devtools.md:18`).

```ts
import { attachDevtools } from "@vectojs/devtools";
import { auditScene, captureSnapshot, explainHitTest } from "@vectojs/devtools/headless";

if (import.meta.env.DEV) {
  const devtools = attachDevtools(scene, { traceEvents: true });
  // devtools.detach() === devtools.destroy()
}
```text

`DevtoolsOptions` at `packages/devtools/src/panel.ts:42` — `width` default 360, `refreshInterval` default 500, `dockSide` `right|left`, `showPerf` default true, `traceEvents`/`traceCapacity`, `defaultTab`. The headless subpath exists so a production test bundle can pull the model layer without the panel or `@vectojs/ui` (`vectojs-docs/content/reference/devtools.md:58`).

## 2a. What the panel shows — and what it deliberately does not

The dock header at `packages/devtools/src/panel.ts:306` carries three ghost buttons — **⌖** pick (`panel.ts:340`), **⟳** refresh (`panel.ts:341`), **⚠** audit (`panel.ts:342`) — and three count `Pill`s (`panel.ts:104`): total entities, interactive **⚡**, and audit findings **⚠** (`panel.ts:345`). A `Tabs` bar at `panel.ts:537` splits the tools into **Tree · Info · Audit · A11y · Log · ⚙**, plus one tab per registered `PluginInspector` (`panel.ts:530`, `panel.ts:1027`).

- **Tree** — `TreeView` at `panel.ts:383` with a filter `Input` at `panel.ts:371`. `setFilter(text)` at `panel.ts:761` prunes via `applyFilterToTree` (`panel.ts:767`) which shallow-copies `{...node}` so originals keep full child lists; filtered labels are still rewritten on the version-stable fast path. Rows show `type (x,y) W×H ⚡ ▶`.
- **Info** — `INSPECT_ROWS = 20` `Text` lines (`panel.ts:71`) showing six generic lines from `describeEntity` plus descriptor output, inline `x/y/opacity` editors (`panel.ts:418`), and **Copy path / Copy JSON** buttons (`panel.ts:442`) backed by `entityPath` (`inspect.ts:82`) and `inspectEntity` JSON. Arrow keys nudge by 1 px (Shift: 10 px) and `+/-` step opacity by 0.1 (`panel.ts:228`) — confirming which entity owns a layout bug before touching code.
- **Audit** — `TreeView` at `panel.ts:469` listing one row per finding (`panel.ts:844`), `selectFinding(i)` at `panel.ts:860` resolving via merged `auditRows` (scene + plugin at `panel.ts:840`) not just `findings[i]`.
- **A11y** — `A11Y_ROWS = 22` lines (`panel.ts:73`) from `writeA11y` at `panel.ts:1173`: `inspectA11y` readout (`a11yInspect.ts:227`) plus cached `auditA11y` findings with `▸` on the selected entity.
- **Log** — bounded `EventTrace` entries (`panel.ts:511`) when `traceEvents: true` (`panel.ts:47`), `traceCapacity` default 50 (`panel.ts:49`). Updated via `eventTrace.subscribe` → `writeTrace` (`panel.ts:521`) → `panelScene.markDirty()`.
- **Settings (⚙)** — `buildSettings` at `panel.ts:654`: `Toggle` for highlight, `Dropdown`s for `refreshInterval` and `dockSide`. `setRefreshInterval` at `panel.ts:1070` gates both timers; `setDockSide` at `panel.ts:1088` swaps styles via `applyDockSideStyle` (`panel.ts:635`).
- **Perf strip** — pinned bottom `Card` (`panel.ts:557`) reflowed by `layout()` (`panel.ts:608`), reading `Scene.frameStats` every 250 ms (`panel.ts:571`).
- **Selection highlight** — `HighlightEntity` on the host overlay (`panel.ts:874`), default `['aabb']` (`panel.ts:172`), switchable via `setHighlightLayers` (`panel.ts:926`).

The dock container and canvas are `pointer-events: none` (`panel.ts:288`), matching `Scene.a11yRoot` — so empty dock pixels never steal host input.


## 3. Tree model and picking — the same walk the engine uses

### 3.1 The tree model

`buildTreeModel(root)` at `packages/devtools/src/model.ts:31` returns `{ nodes, index }`:

- `nodes` — one entry per direct child of `root`, each with its own subtree. A leaf has `children: undefined`, not `[]` (`model.ts:40`).
- `index: Map<string, Entity>` — every descendant at every depth, keyed by `entity.id`, so a selected id round-trips back to the live entity.
- `label` — `` `${type} (${x},${y}) ${W}×${H} ⚡ ▶` `` baked by `geometryLabel` (`model.ts:16`), with badges only when `interactive` / `hasPendingAnimations()`.

`refreshTreeLabels(nodes, index)` at `model.ts:56` rewrites those geometry badges in place — no node or index churn — returning `true` when at least one label changed so the panel can skip redraw work. The forced reconcile every `RECONCILE_INTERVAL_MS = 3000` (`panel.ts:80`) bounds staleness when something mutated `children` without bumping `structureVersion` (`panel.ts:581`, `vectojs-docs/forge/findings/devtools-and-telemetry.md:356`).

### 3.2 Picking

`findEntityAt(root, x, y)` at `model.ts:82` and `pickInScene(scene, x, y)` at `model.ts:214` are deliberately **the same walk and the same acceptance predicate** as `HitTester.findHitRecursively` (`packages/core/src/tree/scene/HitTester.ts:227`), verified after `vectojs#483`:

- `opacity <= 0` early-return prunes the subtree (`model.ts:86`).
- `insideClipAncestors` (`model.ts:115`) checks every `clipChildren` ancestor's world box via `worldToLocal` — so scrolled-out content is not pickable.
- `isPointerTransparent` (`model.ts:105`) mirrors `HitTester.isPointerTransparent` — `disabled === true` or `pointerEvents: 'none'` opts out of hit but children are still walked.
- Only `isPointInside(x,y)` decides (`model.ts:95`) — no world-AABB fallback, so particles and decorative shapes are never false owners (`model.ts:77`, fixed `vectojs#483`, `forge 2026-08-13`).

`pickInScene` checks the overlay tree first, then the main tree (`model.ts:215`), so an open modal wins over content behind it — the most common "my click went nowhere" surprise. `findEntityAt` also tests the root you pass it, so handing it `scene.rootEntity` can return that root; `pickInScene` is the safer default (`vectojs-docs/content/reference/devtools-inspect.md:46`).

## 4. Selection readout — geometry, descriptors, and owned properties

### 4.1 Two readouts for one entity

- `describeEntity(entity)` at `model.ts:153` — `string[]` for the panel: six fixed lines (type/id, `x/y/w/h` with `*` on layout-owned props, scale/rotation/opacity, `world [a b c d e f]`, interactive/animating, child count), plus a `* prop set by Parent — edits revert` line when `layoutControlledProperties` is non-empty (`model.ts:172`), then the entity's own `getDevtoolsDescriptor()` capped to `DESCRIPTOR_LINE_BUDGET = 12` lines (`model.ts:151`). Field values truncate at 32 chars, notes at 60 (`model.ts:143`). A throwing descriptor contributes `— descriptor threw —` rather than aborting the panel (`model.ts:184`).

- `inspectEntity(entity)` at `packages/devtools/src/inspect.ts:99` — `EntityInfo` (`inspect.ts:4`) for machines: every number rounded to 2 decimals (`inspect.ts:48`), `worldTransform`, `worldBounds`, `interactive/animating/clipChildren/childCount`, optional `text` (via `textPreviewOf` at `inspect.ts:70`, `TEXT_PREVIEW_MAX = 80`), optional `a11y { tag, role, label }`, optional `descriptor`, optional `layoutControlled` (`inspect.ts:42`). Both handle a throwing `getDevtoolsDescriptor()` without crashing the tool — a debug tool that breaks on the entity you are debugging is worse than one missing a field (`inspect.ts:136`).

`entityPath(entity)` at `inspect.ts:82` renders `Scene > Card#a1b2 > Text#c3d4` with ids truncated to 8 chars; the tree top (no parent) is shown as `Scene` — so a detached entity is indistinguishable from the real root, which is worth checking when a path looks suspiciously short.

### 4.2 Layout-owned properties

`layoutControlledProperties(entity)` at `inspect.ts:157` asks the **parent** `getLayoutControlledProperties(child)` — only a container knows which props it overwrites (`ScrollView` distinguishes its internal wrapper from caller-added children). The panel marks those props with `*` inline (`model.ts:161`) and, when the user edits one, explains immediately that the value reverts on the next layout (`panel.ts:1108`, `panel.ts:1153`) instead of silently refusing the edit. Editing a Stack child to see what moves is legitimate; hiding why it snapped back is not.

## 5. Highlight geometry — seven boxes, one bug class

`highlightGeometry(scene, entity, opts?)` at `packages/devtools/src/highlightGeometry.ts:1` returns up to seven `HighlightLayer` values, always in fixed order regardless of request order:

| Kind      | Meaning                                            | Source                                                     |
| --------- | -------------------------------------------------- | ---------------------------------------------------------- |
| `aabb`    | Axis-aligned box of the transformed layout quad    | `getWorldBounds()`                                         |
| `layout`  | True quad with rotation/skew                       | world transform × `[0,0,w,h]`                              |
| `render`  | `getBounds()` — where the entity actually paints   | `entity.getBounds()`                                       |
| `clip`    | Nearest `clipChildren` ancestor's box              | ancestor walk                                              |
| `content` | Selectable DOM content mirror's box                | `rectToSceneBox` via `getContentElement`                   |
| `a11y`    | A11y projection element's box                      | `getA11yElement` at `packages/core/src/tree/Scene.ts:6446` |
| `hit`     | Real hit region sampled by probing `isPointInside` | `sampleHitRegion`                                          |

`divergesFromLayout` on any layer means that box disagrees with the layout quad by more than 1 px — the condition that makes a click land where the user did not aim (`vectojs-docs/content/reference/devtools-inspect.md:222`). `highlightGeometry` never throws; an unavailable layer returns `{ kind, polygons: [], unavailable: reason }`.

`hit` is not in the default set — it samples `isPointInside` on a grid (`hitSampleStep` default 8, `hitSampleBudget` default 4096, `packages/devtools/src/highlightGeometry.ts:1`) and costs `O((w/step)·(h/step))` probes, so halving `step` quadruples cost. Divergence for `hit` is by **area coverage**, not extent, so a circle in a square registers (`vectojs-docs/content/reference/devtools-inspect.md:225`). The panel's `HighlightEntity` at `panel.ts:1337` draws these layers on the _host_ scene's overlay via `showOverlay()` (`panel.ts:876`), colored by `LAYER_COLORS` (`panel.ts:1325`), with `aabb` keeping the original `ACCENT` so existing screenshots stay readable.

## 6. Audits — structured findings, sorted, deterministic

Every audit returns `Finding[]` sorted deterministically so snapshots are stable.

### 6.1 Layout audit

`auditScene(scene, opts?)` at `packages/devtools/src/audit.ts:321` delegates to `auditTree(root, sceneBounds, opts)` at `audit.ts:130`. Four `AuditKind` values (`audit.ts:7`):

- `text-overflow` — measured text box escapes its nearest sized, non-text ancestor.
- `clip-overflow` — content escapes a `clipChildren` ancestor (vertical exempt in `ScrollView`/`VirtualList`/`TreeView`/`Table` via `DEFAULT_SCROLLABLE` at `audit.ts:51`).
- `overlap` — **siblings only**, via a `SpatialHashGrid`-broad-phased walk (`audit.ts:190`) instead of the former O(k²) double loop — each box computed once, only grid-cell neighbors compared. Requires intersection exceeding `tolerance` on both axes (`audit.ts:231`).
- `viewport-overflow` — no sized ancestor at all, and the entity escapes `sceneBounds`.

Options: `tolerance` (default 0.5), `includeOverlay` (default false — modals/highlights are intentionally out-of-flow), `scrollableTypes` (matched by `constructor.name`), `ignore` (prune subtrees), `ignoreOverlap` (allow intentional stacking). `opacity: 0` prunes whole subtrees; findings sorted by `kind → entityPath → otherPath` (`audit.ts:305`). With `includeOverlay: true` the result is two concatenated sorted runs — sort again if one global ordering is needed (`vectojs-docs/content/reference/devtools-audit.md:85`).

`worldBox` at `audit.ts:70` uses the declared `[0,0,w,h]` box via `getWorldTransform()`, not `getWorldBounds()` — for containment the declared box is the contract; render extents belong to `clip-overflow`.

### 6.2 A11y audit

`auditA11y(scene, opts?)` at `packages/devtools/src/a11yInspect.ts:299` emits five `A11yAuditKind` values (`a11yInspect.ts:23`):

`no-accessible-name`, `role-tag-conflict`, `disabled-divergence` (with a dead band at opacity 0.6–0.9), `focusable-but-clipped`, `duplicate-label` (reported against the second onward, `otherId` points at the first). Unlike the layout audit it **includes the overlay by default** — a modal is where focus traps live — and `a11yHidden` prunes the whole subtree. Results are walk-order, with `duplicate-label` appended last (`vectojs-docs/content/reference/devtools-audit.md:137`).

### 6.3 Text shaping audit

`auditTextShaping(scene)` at `packages/devtools/src/textInspect.ts:447` walks `scene.rootEntity` only and emits one kind, `atlas-miss` — glyphs not in the font atlas, sampled to five distinct missings per finding. Only the **prepared-text** path can emit it; a content-grid entity never will (`vectojs-docs/content/reference/devtools-audit.md:157`).

### 6.4 Selection audit

`auditSceneSelection` / `auditEntitySelection` at `packages/devtools/src/selectionAudit.ts:1` compare the entity's own local line geometry against live DOM `Range` rects, normalized into local logical pixels so DPR/zoom is factored out. Finds `selection-drift` per offending line with `expectedLeft/Right`, `actualLeft/Right`, `leftDrift/rightDrift`. Requires a real browser — references `document` unguarded (`vectojs-docs/content/reference/devtools-audit.md:202`) — and clears the user's current selection while it runs.

## 7. Snapshots and diffs — regression without screenshots

`captureSnapshot(scene)` at `packages/devtools/src/snapshot.ts:133` captures a deterministic, JSON-safe tree: child order is render order, numbers rounded to 2 decimals (`snapshot.ts:52`), default-valued props omitted. `diffSnapshots(a, b)` at `snapshot.ts:302` returns `SnapshotDiff[]` with `path / kind('added'|'removed'|'changed') / changes`.

Keying — why a renamed row is not 200 rewritten rows: `nodeKey(entity)` at `snapshot.ts:79` prefers `devtoolsKey` (`k:`) then a11y `label` (`l:`, capped at `KEY_LABEL_MAX = 64` at `snapshot.ts:55`), never draw text (content, not identity) and never entity id (random per run). `keyedPairs` at `snapshot.ts:196` uses keys only when unique on **both** sides of a level; on collision it falls back to index alignment. Paths use `Row{k:row-42}` when keyed, `Row[7]` when not (`snapshot.ts:163`), so the path itself survives reordering (`vectojs-docs/forge/findings/devtools-and-telemetry.md:317`, fixed `vectojs#481/#510`).

Only `COMPARED_KEYS` at `snapshot.ts:142` are compared (`type/x/y/width/height/worldBounds/opacity/interactive/animating/clipChildren/text`); `scene.width/height`, `id`, and `key` produce no diffs, and `added`/`removed` do not recurse.

## 8. Hit explanation and event trace

### 8.1 Explaining a hit test

`explainHitTest(scene, x, y)` at `packages/devtools/src/hitExplain.ts:139` walks the same order and applies the same gates as `HitTester`, but records a `HitCandidate` per node instead of returning on the first hit — every loser with its `HitVerdict` (`hitExplain.ts:20`): `accepted / invisible / clipped / pointer-transparent / outside-shape / occluded`. `invisible` (`opacity <= 0`) prunes the subtree and names how many descendants were skipped (`hitExplain.ts:154`). Overlay first, then main (`hitExplain.ts:267`) — the most common surprise. `occluded` is assigned in a post-pass: an otherwise-accepted entity below the winner is rewritten (`hitExplain.ts:278`), so "how many things are under this pixel" is countable. `formatHitExplanation` at `hitExplain.ts:299` renders indented lines with glyphs `✓ / · / ✗` at `hitExplain.ts:306`.

This is a diagnostic, not a per-frame call — it walks the entire tree. On a WASM hit-grid scene a zero-sized `clipChildren` ancestor can explain as `clipped` while the WASM path still registers the hit: the one documented divergence (`vectojs-docs/content/reference/devtools-inspect.md:293`).

### 8.2 Event routing trace

`createEventTrace(scene, opts?)` at `packages/devtools/src/eventTrace.ts:275` observes browser inputs without adding VMT listeners or changing dispatch. Seven `EventTraceType` values (`eventTrace.ts:6`), four `EventTraceSource` values (`eventTrace.ts:16`: `a11y / content / canvas / document`), `EventTraceOptions.capacity` default 50 (`eventTrace.ts:44`). Each `EventTraceEntry` (`eventTrace.ts:26`) records target id/path, scene+local coordinates, modifiers, `deltaX/Y` for wheel, and final `defaultPrevented`.

`defaultPrevented` finalizes in a **microtask** after projected VMT routing, so it reflects the app's final shortcut/selection decision (`eventTrace.ts:95` `onEventBubbled`). A test must await a macrotask before asserting. `pointermove` is coalesced to one per ~60 Hz frame (`POINTERMOVE_COALESCE_MS = 16` at `eventTrace.ts:77`) to avoid O(n) picks skewing the perf HUD (`eventTrace.ts:69`, `vectojs#707`). It attaches 14 document listeners and is the one headless object that **must** be `destroy()`'d (`eventTrace.ts:171`); `entries` returns the live internal array, not a copy.

## 9. Text, GPU, accelerator and markdown readouts

`inspectText(entity)` at `packages/devtools/src/textInspect.ts:179` returns `TextInspection` (`textInspect.ts:15`) or `null` when neither `.text` nor `.value` is present. Otherwise it carries resolved bidi levels, `levelRuns` and reversal segments, `visualOrder`, grapheme `clusters` re-segmented via `Intl.Segmenter` (`textInspect.ts:148`), and per-glyph detail in one of three tiers (`textInspect.ts:157`):

| Tier                  | `glyphs[].x` | `metrics/lines` | `atlasMiss` |
| --------------------- | ------------ | --------------- | ----------- |
| Prepared content grid | yes          | yes             | never       |
| Prepared text         | no           | no              | yes         |
| Neither               | no glyphs    | no              | no          |

`unavailable: string[]` (`textInspect.ts:74`) names every capability that could not be reported and why — a missing field is always explained, not silently absent. `shapeProbe(text, opts?)` at `textInspect.ts:295` runs an arbitrary string through the same pipeline with no entity or scene, so shaping can be checked in a unit test. `formatTextInspection` at `textInspect.ts:348` renders `PluginRow[]` for panel/plugin tabs.

`gpuInspector` / `inspectGpu(scene)` at `packages/devtools/src/gpuInspect.ts:1` and `acceleratorInspector` / `inspectAccelerators(scene)` at `packages/devtools/src/acceleratorInspect.ts:1` expose the GPU and WASM backend posture. `inspectGpu` reports draw counters (`enableDrawCountersCommand` / `resetDrawCountersCommand` at `gpuInspect.ts:1`), overdraw, and `save/restore` balance; `inspectAccelerators` reports per-backend `AcceleratorReport { status, reason }` at `packages/core/src/tree/scene/WasmBackendFacade.ts:66` — whether the WASM hit/grid/anim kernel accepted its arguments or fell back to JS and why. Both are pure reads, so a CI gate can assert `auditGpu(scene).length === 0` just like the layout gate.

`inspectMarkdownStream(entity)` at `packages/devtools/src/markdownInspect.ts:1` reports streaming reuse (`auditMarkdownStreaming` / `markdownStreamAudit`) — how many tokens survived a delta reconcile versus how many entities were rebuilt — and `selectionAudit` / `highlightGeometry` already covered above. Every readout follows the same contract: never throw, return `{ unavailable: reason }` when the entity lacks the capability, and round numbers to 2 decimals.

## 10. Dirty-frame attribution and live frame telemetry

### 10.1 `diagnoseDirty` — why `onDemand` never sleeps

`diagnoseDirty(scene, opts?)` at `packages/devtools/src/dirtyDiagnosis.ts:70` turns `Scene.dirtyReasons` into a verdict. `scene.setDirtyTracking(true)` (`packages/core/src/tree/Scene.ts:3474`) opts in; `scene.dirtyReasons: DirtyReasonEntry[]` (`Scene.ts:3489`, most-frequent first, FIFO-capped at `MAX_DIRTY_REASONS = 200` in `packages/core/src/tree/scene/DirtyTracker.ts:71`) holds `{ entity?, reason, property?, count, firstFrame, lastFrame }`. `diagnoseDirty` computes `perFrame = count / frames` (`dirtyDiagnosis.ts:97`) and separates `everyFrame: perFrame >= 0.9` (`dirtyDiagnosis.ts:105`) — these are what an `onDemand` scene must stop doing to actually idle. `summary` names the worst cause when `everyFrame` is non-empty, notes the moot case when `renderMode === 'always'` (`dirtyDiagnosis.ts:112`), and warns when tracking was never enabled (`dirtyDiagnosis.ts:82`). Headless on purpose — usable from Vitest/Playwright/CI with no panel and no `@vectojs/ui` dep.

### 10.2 `Scene.frameStats` — rendered frames, not vsync

`Scene.frameStats: FrameStats` at `packages/core/src/tree/Scene.ts:3515` (`FrameStats` at `Scene.ts:518`) reads the real loop telemetry:

`fps` (EMA-smoothed rendered-frame cadence, clamped to `maxFPS`, `0` before the first pair), `frameTimeMs` (wall-clock of the last `render()` only), `frameIntervalMs`, `dt`, `renderedFrames/skippedFrames` counters, `renderMode`, `dirty`. The panel's perf strip at `panel.ts:800` shows `fps · ms/frame / entities · mode · rendered/skipped`, updated every 250 ms (`panel.ts:571`). An idle `onDemand` scene honestly reads `0 fps`; an auto-throttled `'always'` scene reads its `idleFPS` floor (60 by default) (`vectojs-docs/content/reference/devtools.md:72`). The renderer always repaints the full canvas, so there is no dirty-rect — `dirty` is the boolean redraw-pending flag (`vectojs-docs/forge/findings/devtools-and-telemetry.md:73`). The lesson from `forge 2026-07-18`: never sample rAF independently — only an entity's `update()` or `frameStats` measures frames Scene actually rendered.

Other Scene surfaces the headless layer reads: `structureVersion` (`Scene.ts:3462`, `Scene.ts:1636`) for tree-shape staleness, `getA11yTree()` (`Scene.ts:5412`) for the public a11y snapshot, `getA11yElement(id)` (`Scene.ts:6446`) and `getContentElement(id)` for DOM-vs-canvas box comparison (`packages/devtools/src/a11yInspect.ts:143`), `getContentProjection()` per entity, and the plugin readouts below.


## 10a. Scene integration points — where DevTools reads the engine

The headless layer never reaches into Scene privates; it reads the public surface that `packages/core/src/tree/Scene.ts` publishes for any consumer, and that `packages/core/src/index.ts` re-exports as public API:

- `Scene.structureVersion: number` at `Scene.ts:3462` (backed by `WasmBackendFacade.structureVersion` at `Scene.ts:1636`) — bumped by `Entity.add/remove` (`packages/core/src/tree/Entity.ts:1086` / `:1123`). Every tree-shape cache is valid while this is unchanged; property changes deliberately do not bump it, which is why `refreshTreeLabels` exists.
- `Scene.frameStats: FrameStats` at `Scene.ts:3515` / `FrameStats` at `Scene.ts:518` — the only honest FPS source, plus `frameTimeMs`, `frameIntervalMs`, `dt`, `renderedFrames/skippedFrames`, `renderMode`, `dirty`. Updated in `Scene.loop` at `Scene.ts:5569` around the `render()` call; `step(dt)` at `Scene.ts:3420` leaves them zeroed.
- `Scene.dirtyReasons: DirtyReasonEntry[]` at `Scene.ts:3489` and `setDirtyTracking` at `Scene.ts:3474` / `DirtyTracker` at `packages/core/src/tree/scene/DirtyTracker.ts:70` — bounded FIFO (`MAX_DIRTY_REASONS = 200` at `DirtyTracker.ts:71`) keyed by `entity:reason.property` (`DirtyTracker.ts:120`).
- `Scene.getA11yTree(): A11yTreeNode[]` at `Scene.ts:5412` (`A11yTreeNode` at `Scene.ts:538`) and per-entity `getA11yElement(id)` at `Scene.ts:6446` / `getContentElement(id)` — the live DOM mirrors whose `getBoundingClientRect()` is compared to `getWorldBounds()` in `highlightGeometry` and `inspectA11y`.
- `Scene.renderMode: 'always' | 'onDemand'` at `Scene.ts:1147`, `SceneOptions.renderMode` at `Scene.ts:408`, and the `DirtyTracker` delegation at `Scene.ts:3443` — the policy `diagnoseDirty` attributes.
- `Entity.getDevtoolsDescriptor(): DevtoolsDescriptor | null` at `packages/core/src/tree/Entity.ts:1937` and `getLayoutControlledProperties(entity)` at `packages/core/src/tree/Entity.ts:968` — the two app-supplied hooks that keep DevTools from needing a table of component types.

Subclasses that own GPU/DOM resources override `destroy()` before calling `super.destroy()` (`packages/core/src/tree/ComputeParticleEntity.ts:419`, `DOMPortalEntity.ts:142`), so a panel that holds a `Map<string, Entity>` index (`panel.ts:157`) never retains a disposed entity.

## 11. Bridge and plugin protocol

### 11.1 The JSON-RPC bridge

`createDevtoolsBackend(scene, transport, opts?)` at `packages/devtools/src/bridge.ts:131` and `createDevtoolsClient(transport, opts?)` at `bridge.ts:328` speak a versioned protocol (`DEVTOOLS_PROTOCOL_VERSION = 1` at `bridge.ts:33`, `DEVTOOLS_CHANNEL = 'vectojs-devtools'` at `bridge.ts:36`) over a `DevtoolsTransport` (`bridge.ts:97`) — a duplex `send / subscribe` abstraction. `DevtoolsMethod` at `bridge.ts:39` enumerates 20 methods (`protocol.version`, `tree.get`, `entity.inspect/pick/highlightGeometry`, `scene.audit/a11yAudit/a11yOrder/snapshot/diff/frameStats`, `hit.explain`, `text.inspect`, `markdown.stream`, `gpu.inspect`, `plugin.list/rows/audit`, `command.list/run`). Each handler is wrapped so a malformed scene answers with `ok: false` rather than killing the backend (`bridge.ts:290`).

`tree.get` serializes up to `maxTreeNodes = 5000` by default (`bridge.ts:118`) and reports `truncated: true` instead of silently cutting (`bridge.ts:178`). Responses are round-tripped through `JSON.parse(JSON.stringify(result))` so a handler returning a live entity fails in the backend's own tests rather than as a `structuredClone` error in an extension (`bridge.ts:300`). `allowedOrigins` is **required** for any cross-document transport — a backend that answers anyone discloses scene content to any frame that can `postMessage` it (`bridge.ts:104`). Two transports ship: `createDirectTransportPair()` for tests/agents (`bridge.ts:404`) and `createWindowTransport(target, targetOrigin)` for extensions/parent frames which forwards `event.origin` for the allowlist check (`bridge.ts:439`). `publishSelection` / `publishStructure` at `bridge.ts:459` / `bridge.ts:469` emit backend-initiated `DevtoolsEvent` notifications (`bridge.ts:81`).

One backend serves every frontend — the in-page panel, a browser extension, Playwright, and agents — so four implementations of the same queries do not drift (`bridge.ts:21`).

### 11.2 Plugins

`registerDevtoolsPlugin(plugin)` at `packages/devtools/src/plugin.ts:1` adds an inspector tab, audits, and commands that outlive a single selection. `PluginInspector` at `plugin.ts:1` is `{ id, label, appliesTo?, inspect(ctx): PluginRow[] }` — the same `PluginRow { label, value, note? }` shape a component's own `getDevtoolsDescriptor()` field uses, so forwarding a descriptor needs no translation. `PluginAudit` returns `PluginFinding[]` which the panel appends as ordinary findings so `selectFinding(i)` needs no knowledge of where a finding came from (`panel.ts:830`). The panel pre-allocates `PLUGIN_ROWS = 18` `Text` rows per plugin tab (`panel.ts:94`) and rebuilds plugin tabs when a package registers late via `syncPluginTabs()` at `panel.ts:1027` — before the version check, so a newly imported plugin does not wait for the next structural change.

## 12. Panel internals that matter

- **Reflow owns its own resize.** The panel scene is `disableWindowResize: true` and must call `panelScene.resize(width, innerHeight)` on every `window.resize` (`panel.ts:608` `layout()`), repositioning the tabs height, tree/audit heights, and perf card. Without this the bottom-anchored perf strip falls below the fold at any shorter viewport — the bug that shipped at 100% zoom (`vectojs-docs/forge/findings/devtools-and-telemetry.md:100`, fixed in `vectojs#132`).

- **Version-gated refresh with periodic reconcile.** `refresh()` at `panel.ts:709` skips the walk when `host.structureVersion === treeVersion` and `allNodes` is non-empty — so a 60 Hz interval is cheap — but still rewrites labels (`refreshTreeLabels` on both `allNodes` and `filteredNodes` at `panel.ts:733`) and rewrites selection/plugin readouts. A forced reconcile every `RECONCILE_INTERVAL_MS` (`panel.ts:591`) bounds how long a direct `children` mutation without a version bump can stay stale.

- **`pointer-events: none` dock contract.** The dock container and its canvas are `pointer-events: none`; only a11y-projected controls opt back in via `auto` (`panel.ts:288`), mirroring `Scene.a11yRoot` (`vectojs-docs/forge/findings/devtools-and-telemetry.md:29`, fixed `@vectojs/devtools@0.4.3`). The pick handler checks `container.contains(ev.target)` before consuming a click (`panel.ts:219`), so arming pick mode does not swallow the panel's own buttons (`vectojs#482`, `forge 2026-08-13`).

- **A11y audit cached, not re-walked per tick.** `writeA11y` runs every tick (it is the selection's readout), but the full-scene `auditA11y` walk is cached on `structureVersion` with a `A11Y_AUDIT_TTL_MS = 3000` staleness TTL (`panel.ts:85`, `panel.ts:1246`) — audit inputs include labels/disabled/opacity/tabIndex/bounds with no version counter, so a pure version key went stale indefinitely (`vectojs#496`, `forge 2026-08-13`).

- **Filter-safe labels and plugin safety.** With a filter active the `Tree` renders pruned copies; filtered labels must be rewritten too or rows freeze at the last rebuild's geometry (`panel.ts:736`, `#786`). A throwing `appliesTo` or `getA11yAttributes()` degrades to "does not apply" / a per-entity verdict rather than blanking the panel (`panel.ts:1298`, `a11yInspect.ts:179`, `vectojs#496`).

## 13. Hard parts — with receipts

| Pitfall                                                                     | Where                                                   | Status                               |
| --------------------------------------------------------------------------- | ------------------------------------------------------- | ------------------------------------ |
| Dock overlay swallows host pointer input                                    | `panel.ts:288`, forge 2026-07-16                        | Fixed `@vectojs/devtools@0.4.3`      |
| Independent rAF FPS measures display vsync, not Scene cadence               | `Scene.ts:518` `FrameStats`, forge 2026-07-18           | Fixed `core@1.13.0` via `frameStats` |
| Panel overflows viewport at any shorter height                              | `panel.ts:608` `layout()`, forge 2026-07-21             | Fixed `devtools@0.5.0`               |
| Focus/workspace decides Chrome cadence; Firefox needs `layout.frame_rate`   | `benchmarks/run-browsers.sh`, forge 2026-08-02/03       | Fixed `vectojs#326/#327/#333`        |
| Snapshot mixed keyed/unkeyed level pairs one node twice and drops removals  | `snapshot.ts:196`, forge 2026-08-13                     | Fixed `vectojs#481/#510`             |
| Pick mode swallows panel's own control clicks                               | `panel.ts:219`, forge 2026-08-13                        | Fixed `vectojs#482/#510`             |
| `findEntityAt` claimed engine parity but omitted opacity/clip/pointer gates | `model.ts:82`, `HitTester.ts:227` vs `forge 2026-08-13` | Fixed `vectojs#483/#510`             |
| Canvas-vs-DOM drift compared logical px against client px                   | `a11yInspect.ts:143`, `panel.ts:1099`                   | Fixed `vectojs#484/#510`             |
| `selectFinding` ignored plugin findings                                     | `panel.ts:860`, forge 2026-08-13                        | Fixed `vectojs#496/#518`             |
| `accessibleName` was the truncated 80-char preview                          | `a11yInspect.ts:160`, `inspect.ts:70`                   | Fixed `vectojs#496/#518`             |
| Inspector warning dropped at the row budget                                 | `model.ts:153` + `panel.ts:1143`, forge 2026-08-13      | Fixed `vectojs#496/#518`             |
| Full-scene a11y audit re-walked every 500 ms tick                           | `panel.ts:1246`, forge 2026-08-13                       | Fixed `vectojs#496/#518`             |
| Throwing `getA11yAttributes()` killed the whole a11y audit                  | `a11yInspect.ts:179`, forge 2026-08-13                  | Fixed `vectojs#496/#518`             |

## 14. Checklist — before you land a DevTools change

1. **Headless first.** Add the pure function, test it via `createDirectTransportPair()` with no browser, then wire the panel. A protocol validated by one real consumer beats a UI rebuilt around an unvalidated one (`bridge.ts:21`).
2. **Throw-safe.** Guard every `getA11yAttributes()` / `getDevtoolsDescriptor()` / `appliesTo` call — a broken component must degrade, not blank the tool (`model.ts:184`, `inspect.ts:136`, `panel.ts:1298`).
3. **Hit parity.** Any new visibility/input/clip gate must land in both `HitTester.findHitRecursively` and `isHitEligible` _and_ the headless pick/explain walk (`HitTester.ts:227` vs `model.ts:82` vs `hitExplain.ts:139`, `vectojs#483`).
4. **Allowed origins or direct pair only.** A cross-document backend without `allowedOrigins` is an information disclosure vector (`bridge.ts:104`).
5. **Version-keyed caches need a TTL.** A `structureVersion`-only key for something that also depends on labels/opacity/bounds goes stale forever (`panel.ts:1246`).
6. **Keep the dock non-interactive.** The container/canvas stay `pointer-events: none` (`panel.ts:288`); controls opt back in. A regression here silently deadens the host's right-edge controls.

## 15. Debugging workflows — which tool for which symptom

| Symptom                                      | Workflow                                                                                                                                       |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| "Which entity owns this pixel?"              | `pickInScene(scene, x, y)` → `inspectEntity(hit)` (`packages/devtools/src/model.ts:214`, `packages/devtools/src/inspect.ts:99`)                |
| "The wrong entity owns this pixel"           | `explainHitTest(scene, x, y)` — every loser with the reason it lost (`packages/devtools/src/hitExplain.ts:139`)                                |
| "Why is this entity positioned/sized wrong?" | `inspectEntity` bounds + `getWorldTransform()`, walk `entityPath` upward — first wrong bounds owns the bug                                     |
| "Writes to `x` revert"                       | `inspectEntity(e).layoutControlled` — parent owns that prop (`packages/devtools/src/inspect.ts:42`)                                            |
| "Click target offset from visuals"           | `highlightGeometry(scene, e)` — look for `divergesFromLayout` on `a11y`/`content` (`packages/devtools/src/highlightGeometry.ts:1`)             |
| "Hit area is wrong"                          | `sampleHitRegion(e)` — the real hit region, not the box                                                                                        |
| "Screen reader says nothing"                 | `inspectA11y(scene, e)` for `accessibleName`/`nameSource`; `a11yReadingOrder(scene)` for announce order                                        |
| "Text in the wrong order / blank boxes"      | `inspectText(e)` bidi levels / `glyphs[].atlasMiss` (`packages/devtools/src/textInspect.ts:179`)                                               |
| "An `onDemand` scene never idles"            | `scene.setDirtyTracking(true)` → `diagnoseDirty(scene)` (`packages/devtools/src/dirtyDiagnosis.ts:70`, `packages/core/src/tree/Scene.ts:3474`) |
| "What changed after this interaction?"       | `captureSnapshot` before/after → `diffSnapshots`                                                                                               |

---

_Series: 00 Overview → 01 Selection → 02 Text+Layout → 03 Projection+Virtualization → 04 Streaming Markdown → 05 TeX → 06 VMT Runtime → 07 Renderer → 08 WASM G1/G2/G3 → 09 Three/XR → 10 Video Export → 11 Graph Layout → **12 DevTools** → 99 Synthesis._
