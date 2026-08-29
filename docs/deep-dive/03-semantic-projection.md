---
title: "03 — Semantic Projection + Virtualization"
description: "The three-tier DOM lifecycle — Visual, Semantic, Interaction — and how VectoJS materializes only what is usable, windows what is selectable, and keeps roving focus honest."
order: 23
---

# 03 — Semantic Projection + Virtualization

VectoJS renders **zero visible DOM**. Everything you see is canvas. Everything a screen reader, keyboard user, or Playwright agent touches is a **thin projected shadow** in `Scene.a11yRoot` (a single `position:absolute` div above the canvas, `packages/core/src/tree/Scene.ts:2390`). That shadow is not one-node-per-entity — it is a three-tier lifecycle that bounds cost to the viewport while keeping off-screen text reachable for find and read-ahead.

## The three tiers — one diagram

```text
                      ┌─────────────────────────────────────┐
                      │        Virtual Math Tree (VMT)      │
                      │  Entity tree · worldMatrix · bounds │
                      │  packages/core/src/tree/Scene.ts    │
                      │  packages/core/src/tree/Entity.ts   │
                      └──────────────┬──────────────────────┘
                                     │  syncA11y + syncContentProjection
                                     │  (shared depth-first walk, every frame
                                     │   or throttled — see §2)
                 ┌───────────────────┼───────────────────┐
                 ▼                   ▼                   ▼
   ┌─────────────────────┐ ┌───────────────────┐ ┌─────────────────────┐
   │  Visual tier        │ │  Semantic tier    │ │  Interaction tier   │
   │  (always rendered)  │ │  (coarse, resident)│ │  (windowed, fine)  │
   │                     │ │                    │ │                     │
   │  Canvas2D / WebGL / │ │  One DOM node per  │ │  Per-line carriers  │
   │  WebGPU / SVG draws │ │  block holding its │ │  (spans per line /  │
   │  every entity that  │ │  full `text` so    │ │  spans per glyph    │
   │  passes culling.    │ │  find-in-page and  │ │  cluster when grid) │
   │  Subject to         │ │  read-ahead see    │ │  plus a11y mirrors  │
   │  `getRenderChild-   │ │  the whole doc.    │ │  (`button`, `grid-  │
   │  Range` /           │ │  Outside the       │ │  cell`, hotspots).   │
   │  viewportCullChild- │ │  interaction margin│ │  Only near-viewport │
   │  ren. No DOM cost.  │ │  carriers are NOT  │ │  materialized.      │
   └─────────────────────┘ │  built.            │ └─────────────────────┘
                           └───────────────────┘
        Pixels ─────────────►  `getContentProjection().text`  ─────────►  `lines` / `grid`
                              `SceneOptions.contentSemanticMargin`
                                                            `SceneOptions.contentProjectionMargin`
                                                            `SceneOptions.contentSemanticBudget`
```text

Why two margins? One scalar cannot express "every block has DOM but only near-viewport blocks have carriers" — a finite value freed off-band blocks entirely while `Infinity` also unwindowed every carrier (`O(total glyphs)`). See `SceneOptions.contentSemanticMargin` vs `contentProjectionMargin` (`Scene.ts:328`, `336`, `359`) and the rejected-enum rationale in `vectojs-docs/forge/baselines/content-projection-frontload-findings.md:1`.

| tier               | where it lives                                          | gated by                                                                               | default                                                    |
| ------------------ | ------------------------------------------------------- | -------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| Visual             | canvas backing stores                                   | `viewportCullChildren` + `getRenderChildRange` (`Entity.ts:788`, `1970`)               | cull off — opt in per container                            |
| Semantic (coarse)  | one `div` per block, `el.textContent = projection.text` | `contentSemanticMargin` — whether the block has _any_ DOM                              | `contentProjectionMargin ?? Scene.height` (`Scene.ts:355`) |
| Interaction (fine) | per-line / per-cell carriers + a11y mirrors             | `contentProjectionMargin` + `projectionLineWindow` (`scene/content-line-window.ts:25`) | one viewport height                                        |

`contentSemanticBudget` (`Scene.ts:359`, `DEFAULT_CONTENT_SEMANTIC_BUDGET = 256` at `Scene.ts:600`) spreads the one-time resident-tier build across frames — only coarse blocks are budgeted; a block inside the interaction band materializes immediately regardless of budget.

## How the `syncA11y` walk works — and when

`syncA11y` is not "an a11y method." It is the **shared depth-first walk driver** for a11y _and_ content projection (`A11yProjectionManager.ts:30`, `ContentProjectionManager.ts:26`). Splitting them required `DEC-0020`/`DEC-0022` for a reason: the recursion point calls `syncContentProjection`, and `syncA11y` initializes the four per-sync fields the content side reads (`_syncSerial`, `contentSemanticBudgetLeft`, `contentSemanticDeferred`, `contentSelectionPresentThisSync`). `DirtyTracker` (`scene/DirtyTracker.ts:33`) gates whether the walk runs at all; `a11ySyncInterval` throttles it further without breaking the budget.

Per frame (or throttled to `a11ySyncInterval`, `Scene.ts:263`):

1. **Collect + dirty check.** Each `interactive` entity with a non-zero box (or `a11yFullViewport`, `Entity.ts:912`) calls `getA11yAttributes()` (`Entity.ts:1898`). The walk reads `interactive`, `a11yHidden`, `a11yProjection`, and `a11yFullViewport` together — a hidden ancestor hides its whole subtree regardless of child flags (see § Focus). If `getContentEpoch()` (`Entity.ts:2048`) hasn't bumped, unchanged content blocks skip rebuild entirely. The epoch is the content-projection equivalent of the VMT dirty flag — cheap integer compare, no string diff. Entities that return `null` from `getContentProjection()` pay no content cost at all.
2. **Create / update / reposition.** The walk creates the shadow element (`a`/`button`/`img`/`input`/`textarea` or `div`, `A11yAttributes.tag` at `Entity.ts:295`), applies every `A11yAttributes` field with per-attribute dirty checking (returning `undefined` removes the attribute — `false` vs `undefined` matters for `aria-invalid`), and writes `top`/`left`/`width`/`height` from the entity's world matrix through `CanvasGeometry` (`scene/CanvasGeometry.ts:93`). Canvas offset and non-uniform CSS scaling are mapped; arbitrary CSS rotation/skew of the canvas parent is unsupported. `A11yAttributes.level` / `posInSet` / `setSize` / `rowCount` / `rowIndex` are projected as `aria-level` / `posinset` / `setsize` / `rowcount` / `rowindex` — required for virtualized lists/grids so AT announces the dataset size, not the window.
3. **Ordering + prune.** `A11yProjectionManager.collect` (`A11yProjectionManager.ts:157`) takes the nearest `a11yRegion`/`clipChildren` ancestor as the element's _region_; `reorder` (`A11yProjectionManager.ts:178`) band-sorts `normalElements` into visual reading order (`sortNormalElementsVisually`, `A11yProjectionManager.ts:351`) and cursor-inserts per DOM parent so composite nesting (`grid > row > gridcell`) is preserved. Focus and `Selection` endpoints inside a moved subtree are snapshotted once — paying one forced layout per _reordering_ pass rather than per moved element (`A11yProjectionManager.ts:230`). Anything not collected this pass is pruned (`isActive` at `A11yProjectionManager.ts:169`). `a11yNeedsReorder` (`Scene.ts:1381` / `A11yProjectionManager.ts:88`) is the flag that triggers the sort.
4. **Content side.** At its recursion point the walk calls `syncContentProjection` for every entity whose `getContentProjection()` is non-null. The box test (`projectionBoxVisible`) decides coarse vs released; the line band (`projectionLineWindow` / `projectionGridLineWindow`, `scene/content-line-window.ts:2`) decides which lines of a surviving block get carriers. Grid blocks go through `ContentGridProjector.syncGrid` (`scene/ContentGridProjector.ts:69`) with per-line signatures so streaming appends reuse unchanged carriers; non-grid blocks use `el.replaceChildren()`. `ContentProjectionHint` (`Entity.ts:ContentProjectionHint`) lets the Scene tell the entity which band is actually needed so `getContentProjection` can avoid building discarded lines — advisory, so ignoring it is always correct.

### Lifecycle hooks

`Entity.onMounted()` fires once when the entity enters a live Scene (`Entity.ts:add` / `_notifyMounted`). A hotspot pool that needs to know when to allocate can override it; `remove(child)` calls `scene.detachA11y(child)` (`Entity.ts:remove`) and marks `a11yNeedsReorder`. `Scene.detachA11y` is idempotent — second detach is a no-op — so `Tabs`/`Table` pool cleanup that detaches hotspots before removing the row is safe even if the entity was already gone.

### Budget and margin control

Three knobs, one contract:

- `contentProjection: false` disables the _entire_ content layer (decorative scenes).
- `contentProjectionMargin` (default one viewport height, `Scene.ts:328`) — interaction window. Finite = carriers windowed; `Infinity` = every carrier materialized (forbidden in production — `O(glyphs)`).
- `contentSemanticMargin` — coarse gate. `Infinity` + finite interaction margin = every block has `text` for find/read-ahead while only near-viewport blocks pay for carriers. The safe, wanted configuration for a resident tier. Without it the same `Infinity` would unwindow carriers too.
- `contentSemanticBudget = 256` — how many coarse blocks may materialize per sync. Bounds the document-open stall (measured ~0.03 ms per block plus a per-pass floor growing with resident count). Visible blocks ignore the budget.

The budget was sized by measurement in `DEC-01KZ8DZE` after the memo fix below; see `forge/baselines/content-projection-frontload-findings.md:Two approaches rejected`.

### Why not one DOM per Entity

Cost is super-linear in projected-node count. Measured on real hardware (RTX 4060 Laptop, moving entities, one element each) — `content/learn/accessibility.md:353`:

| interactive entities | Chrome/frame | Firefox/frame |
| -------------------- | ------------ | ------------- |
| 1,000                | 6.4 ms       | 7.4 ms        |
| 5,000                | 59.5 ms      | 114 ms        |
| 20,000               | 715 ms       | 2737 ms       |

Per-entity cost _rises_ with count (the sort + browser a11y-tree rebuild degrade). A second measurement at 5,000 moving entities (`Entity.ts:933` doc, `benchmarks/lazy-a11y/`): `eager` = **72.2 ms Chrome / 114.3 ms Firefox** vs `onDemand` = **1.55 / 1.63 ms**, floor without projection **1.26 / 1.65 ms**. The walk itself is ~0.005 µs/entity — the DOM is the cost. One DOM per Entity at 36,000 entities is therefore not a linear extrapolation — it is dominated by the a11y-tree rebuild, which is why the same doc quotes the 36,000→1,026 collapse as the _system_ win, not the walk win.

### Engagement — `a11yProjection` modes (`Entity.ts:968`)

- `eager` (default) — mirror lives as long as `interactive` + box. For buttons, links, inputs.
- `onDemand` — mirror only while _engaged_: focused, pointer target, or `Scene.requestA11yProjection(id)` (`Scene.ts:1481`). Hover alone does **not** engage (keyboard/AT users generate no hover). An `onDemand` entity with no mirror receives **no pointer events at all** — canvas hit-testing (`findEntityAt`) is a query API, not a dispatch path (`Entity.ts:953`).
- `never` — no mirror ever. Prefer `interactive = false` unless hit-testing must stay.

For thousands of ephemeral objects (particles, danmaku) the pattern is one aggregate live region (`role: 'status'`, `a11yFullViewport`, `Entity.ts:193`) plus a small hotspot pool for the current selection — see `forge/findings/core-a11y-and-input.md:178` (Bakudan `DanmakuAnnouncer`).

## Virtualization — scrolling without paying for the document

### ScrollView / Viewport

The primitive scroller (`packages/ui/src/ScrollView.ts:58`) is a clipped container (`clipChildren = true`) whose `content` child translates by `-scrollTop`. It exposes `scrollTo` / `scrollToBottom` / `jumpTo`, drives an exponential spring integrator in `update` (`ScrollView.ts:219`), and keeps scroll state visible to idle checks via `hasPendingAnimations()` so `onDemand` scenes don't stall mid-scroll. `driveVirtualizableContent` (`ScrollView.ts:233`) lets a `VirtualList` child own its own windowing inside the scroll.

A `Flow` or `Stack` inside a `ScrollView` does normal layout; only the clip + translation virtualizes the _paint_ — DOM cost is still bounded by content-projection windowing. `Flow` wraps at `maxWidth`; `Stack` is the vertical/horizontal gap container (`packages/ui/src/Stack.ts`, `Flow.ts`). `Card` is a decorated group (`packages/ui/src/Card.ts:80`, `role: group` when labelled) — not virtualized itself, but a common child of a virtualized viewport.

`getA11yAttributes()` returns `{ pointerEvents: 'none' }` (`ScrollView.ts:289`) — the scroll surface itself is not a hit target; descendants own the pointer (see hotspot § below). `a11yHidden` on a collapsed `ScrollView` hides its subtree from projection even while the clip animation runs (`Entity.ts:a11yHidden`, verified on `Overlay` after `hide()`).

### VirtualList — windowing rows (`packages/ui/src/VirtualList.ts:179`)

Only rows in `[visibleTop - overscan, visibleBottom + overscan]` are mounted (`_visibleRange` at `VirtualList.ts:468`, `overscan = 3` by default, `VirtualListOptions:102`). The rest do not exist as entities — no canvas draw, no a11y mirror, no content projection. Mount count stays `O(viewport)` regardless of dataset size.

Scrolling math is `O(log n)` via a Fenwick tree (`RowHeights`, `VirtualList.ts:14`) answering `total()`, `prefix(i)` (= y of row `i`), and `indexAt(y)` (= row containing offset `y`). Heights start at `estimatedRowHeight` and are re-measured per mounted row each frame (`_measureMountedRows`, `VirtualList.ts:540`) — a plain field read, no dirty flag needed, and no `markDirty` on the no-change path so the idle throttle isn't defeated. `_reconcile` (`VirtualList.ts:488`) recycles out-of-range entities before mounting new ones.

Keyed lists (`keyForItem`, `VirtualList.ts:117`) preserve measured heights across `setItems`, anchor scroll by item identity (not index), and follow the bottom when `distanceToBottom ≤ 48 px` (`VirtualList.ts:517`). Without `keyForItem`, `setItems` clears the height cache and jumps to top — correct for a replaced list, wrong for a growing transcript.

A11y: the container's count belongs in its **name**, not `aria-setsize` (disallowed on `role="list"`), per `getA11yAttributes` at `VirtualList.ts:660` and the class doc at `VirtualList.ts:170`. Each _row_ should return `posInSet` / `setSize` (`Entity.ts:A11yAttributes.posInSet`/`setSize`) or a screen reader announces the mounted window's size instead of the dataset's. `VirtualList` pools its row hotspots the same way `Table` does — one pool per visible row.

### Content grid tiling — coarse vs fine (§ diagrams above)

Two paths share one windowing contract (`scene/content-line-window.ts`):

- **Non-grid** (paragraphs, `Text`/`RichText`): `projectionLineWindow` (`content-line-window.ts:44`) over `ContentProjection.lines`. Coarse blocks hold one text node (`el.textContent = projection.text`); fine blocks replace carriers per window. Each `ContentProjectionLine` carries `text`, `separatorAfter` (consumed soft-wrap vs hard break), `x`/`y`/`baseline`, optional `runs` with `x`/`width` for justified text, and `perGraphemeCarriers`/`shapedPaint` for CJK grid-fit.
- **Grid** (code blocks, `Markdown` CodeBlock via `PreparedContentGrid` in `@vectojs/text`): `projectionGridLineWindow` (`content-line-window.ts:114`) over `PreparedContentGrid`. `ContentGridProjector.syncGrid` builds one span per glyph cluster with per-cell `scaleX` calibration (`ContentProjectionManager.scheduleGridCalibration`, cold read/write batch outside sync), and reuses lines by signature (`ContentGridProjector.ts:199`) so streaming appends avoid `O(cells)` rebuilds. `ligatures: 'none'` on grid text prevents Firefox `ffi` contraction from drifting selection boxes.

The window is the **contiguous run overlapping the expanded viewport band** — a gap would splice text out of DOM order and break selection copy order. When nothing overlaps, the single nearest line is kept so text stays reachable (`content-line-window.ts:79`). Promotion (coarse→fine) strips the coarse text node explicitly — grid cannot use `replaceChildren()` or streaming reuse is lost (`ContentGridProjector.ts:111`). Demotion releases DOM; the semantic gate keeps findable text without carriers.

Selection preservation is tier-aware: `ContentProjectionManager` (`scene/ContentProjectionManager.ts:1`) snapshots endpoints as _linear offsets_ for non-grid and _source offsets_ for grid, memoizes `selectionPresent` per walk (one forced layout per walk, not per element — memoized fix took a 1000-block drain from 2002 layouts to 19, `forge/baselines/content-projection-frontload-findings.md:153`), and restores only when the affected line was actually rebuilt — reused carriers keep the live `Selection` nodes. `clipToBounds` on a scrolling code block prevents a selection highlight from painting past the entity box.

### Markdown + Table tiling

- **Markdown** (`packages/markdown/src/Markdown.ts:681`) — two independent axes: `virtualize` (`MarkdownOptions:625`) windows top-level _blocks_ as entities (opt-in, incompatible with streaming, driven by `setVisibleRange` from a host `ScrollView` with `RowHeights` at `Markdown.ts:774`), while `tableViewportHeight` (`MarkdownOptions:652`) fixes each `Table`'s body viewport so its rows virtualize mid-stream via `Table.appendRows`. A `Stack` with `cullOffscreenChildren` is the content host in both cases. `Markdown` owns `getContentProjection` per block; the host owns scroll. Streaming Markdown reuses unchanged block entities by prefix — only the tail rebuilds (boss 04).
- **Table** (`packages/table/src/Table.ts:144`) — `viewportHeight > 0` pins the header, creates a clipped scrolling `bodyClip` (`Table.ts:183`), lazily constructs string cells on window entry (`ensureBodyCells` at `Table.ts:853` / `reconcileVirtualRows` at `Table.ts:392`), and keeps only `first..last` rows mounted (`overscan = 2`). Classic mode grows to fit all rows with variable measured heights. Body a11y is a pooled `RowHotspot` (`role: row`) + `GridCellHotspot` (`role: gridcell`/`columnheader`) per visible row — `O(viewport)`, not `O(rows)` (`Table.ts:199`, `622`). `getContentProjection` returns `null` on the `Table` itself — cells own their text. `rowTops` prefix sums (`Table.ts:751`) make `_syncGridA11y` O(1) per slot instead of O(rows²).

### Stack / Flow / Card inside a viewport

`Stack` (`packages/ui/src/Stack.ts`) and `Flow` (`packages/ui/src/Flow.ts`) are non-virtualized layout containers — they position children and report `width`/`height`, but do not clip or window. Inside a `ScrollView` or virtualizing parent they are the _content_ that gets translated or culled:

- `Stack` with `direction: 'vertical'` + `gap` is the Markdown `content` host (`Markdown.ts:1088`) and the typical ScrollView child. With `cullOffscreenChildren = true` it also skips `getContentProjection` for off-screen children — a cheap second gate before the Scene-level windowing.
- `Flow` wraps inline children at `maxWidth` and is the text-paragraph workhorse; like Stack, it relies on its scrolling ancestor for viewport gating.
- `Card` (`packages/ui/src/Card.ts:80`) is a decorated `role: group` container with padding/border/shadow — never virtualized itself, but a frequent child of `VirtualList` rows or `Markdown` blocks. Its a11y role is `group` only when labelled.

None of these own `getRenderChildRange` by default — they paint all children and let the ancestor's clip + projection windowing bound cost. Only `Markdown`/`Table`/`VirtualList` implement row/block-level virtualization.

### Viewport culling — visual tier (`Entity.ts:788`)

Independent of DOM projection:

```ts
entity.viewportCullChildren = true;
entity.getRenderChildRange(localViewport: Bounds): RenderChildRange | null {
  // return { start, end } of children intersecting the viewport, or null for none
}
```text

`Stack`/`Flow` leave this off by default (cheap for modest child counts). Turn it on for a container with thousands of visual children where culling the _canvas_ draw itself matters — projection windowing does not help the visual tier, and the tree walk without culling is `O(total entities)` per synced frame (`forge/baselines/content-projection-frontload-findings.md:Not addressed`, `vectojs#350`).

### Promotion / demotion lifecycle

```text
  off-screen                          near viewport                    on-screen
 ──────────── ──contentSemanticMargin── ──contentProjectionMargin── ────────────
  (released)          (coarse)                     (fine)
  no DOM              el.textContent = text        per-line / per-cell carriers
  not findable        findable, no per-line        findable + selectable +
                      selection geometry            copy + per-line highlight

  demotion ◄──────────────┘                          └──────────────► promotion
  `syncContentProjection` frees carriers;            `syncGrid` strips coarse text node,
  coarse text stays if inside semantic gate;         materializes windowed carriers;
  outside both gates the element is removed.         outside semantic gate but inside
                                                     interaction gate: direct to fine.
```text

Budget applies only to coarse→fine promotion from off-band; scrolling a block that is already coarse into the interaction band ignores the budget.

## Hotspot pattern — zero-DOM semantics that still keyboard

Composite widgets (`role="grid"`, `tree`, `menu`, `radiogroup`, `tablist`) must expose **one role per child**, not just a container role, and must keep **one tab stop** in sequential order — a thousand-tab-stop tree is unusable. VectoJS pools a transparent, focusable child `UIComponent` over each visible child (`vectojs/AGENTS.md:Zero-DOM a11y hotspot pattern`):

```ts
class GridCellHotspot extends UIComponent {
  constructor(private table: Table) {
    super();
    this.interactive = true; // so syncA11y projects it at all
    this.on("keydown", (e) =>
      this.table.handleGridKey(e, this.rowIndex, this.colIndex),
    );
  }
  getA11yAttributes(): A11yAttributes {
    return {
      role: this.rowIndex < 0 ? "columnheader" : "gridcell",
      label: this.label, // WCAG 4.1.2 — every control needs a name
      tabIndex: this.table.isGridTabStop(this.rowIndex, this.colIndex) ? 0 : -1,
      pointerEvents: "none", // lets selectable cell text own the pointer
    };
  }
  render(): void {} // Table paints the cell on canvas
}
```text

| Component         | Hotspot role                                      | Roving stop owner                                 | Keys                                                              |
| ----------------- | ------------------------------------------------- | ------------------------------------------------- | ----------------------------------------------------------------- |
| `Table`           | `gridcell` / `columnheader` in `row`              | `isGridTabStop(row, col)` (`Table.ts:473`)        | Arrows 2D, Home/End row, Ctrl+Home/End grid, PageUp/Down viewport |
| `VirtualList` row | caller-provided (e.g. `listitem`)                 | row's own `isTabStop`                             | Up/Down                                                           |
| `TreeView`        | `treeitem` (`aria-level`, `expanded`, `selected`) | `isTabStop(nodeId)` (`Tree.ts:389`)               | Up/Down, Right expand→enter, Left collapse→parent, Home/End       |
| `ContextMenu`     | `menuitem` (`haspopup`, `expanded`)               | `isMenuTabStop(idx)` (`ContextMenu.ts:270`)       | Up/Down wrap, Home/End, Right open, Left back, Escape close       |
| `RadioGroup`      | `radio` (`aria-checked`)                          | `isTabStop(value)` (`RadioGroup.ts`/`Tabs.ts:42`) | Arrows + Home/End                                                 |
| `Tabs`            | `tab` (`aria-selected`)                           | selected tab                                      | Arrows + Home/End                                                 |

Precedent: `RadioGroup`/`Tabs` (#160), `Tree`/`Table`/`ContextMenu` (#191); live references at `Table.ts:56`, `82`, `Table.ts:624` (`_syncGridA11y`), `VirtualList.ts:170`, `ScrollView.ts:289`, `ContextMenu.ts:292`, `RadioGroup.ts:32`, `Tree.ts:98`. Only visible children are pooled, so a virtualized `Table` projects `O(viewport)` hotspots.

### The `pointerEvents: 'none'` rationale

Canvas input is routed **only through projected mirrors** — `Scene` binds `pointerdown`/`pointerup`/`click`/`wheel` per mirror (`Scene.ts:3512`) and `pointermove`/`pointerleave` on the canvas only for hover tracking. So `pointerEvents: 'none'` on a hotspot does not just "remove it from hit testing" — it removes its mouse input path entirely, while keyboard focus and AT-synthesized `click` still route (`forge/findings/core-a11y-and-input.md:336`). Use it when something _underneath_ owns the pointer:

- selectable cell text (`Table.ts:116`),
- drag-to-scroll surfaces (`ScrollView.ts:289`),
- canvas hit handling inside a wrapper.

Do **not** use it on the element that owns the handler — a `ScrollView` subclass that set `pointerEvents: 'none'` on its own attributes silenced its `wheel`/`pointerdown` scrolling with no error (`forge/findings/core-a11y-and-input.md:336`).

### Focus, roving tabindex, and reading order

- **Roving tabindex**: exactly one hotspot per composite has `tabIndex: 0`; the parent moves the stop on arrow keys and focuses it (`Table.handleGridKey` at `Table.ts:490`, `findHotspot`/`_focusCell` at `Table.ts:560`, `VirtualList`/`Tree`/`ContextMenu` equivalents). When virtualization unmounts the focused row, `Table` re-anchors the stop onto a visible row _before_ rebinding `tabIndex` (`Table.ts:667`) and restores DOM focus only if the old cell actually held it (`activeCellHoldsFocus` at `Table.ts:592`), so scrolling elsewhere never steals focus. The sentinel `a11yRoot` focus trap keeps focus inside the scene (`Scene.ts:1482`).
- **Reading / tab order**: mirrors are band-sorted top→bottom then inline, stable, per _region_ — nearest `a11yRegion` or `clipChildren` ancestor (`A11yProjectionManager.ts:351`). Without regions a vertical drag through a transcript swallows a sidebar whose headings share the same row bands (`A11yProjectionManager.ts:339`). Set `a11yRegion = true` (`Entity.ts:a11yRegion`) on a non-clipping column to keep its drag/contiguity separate. RTL is `Scene.readingDirection` (`Scene.ts:392`). `a11yRoot` layer is `z-index: 10` above the canvas (`Scene.ts:2403`) with `pointerEvents: none` by default, flipped to `auto` only during a drag so selection can start in blank regions.
- **Hiding a subtree**: `a11yHidden = true` (`Entity.ts:a11yHidden`) hides the whole subtree from projection — `interactive = false` on a container alone leaves still-interactive children projected (verified on `Popover.hide`, `forge/findings/core-a11y-and-input.md:622`). Not inferred from `opacity` — spring-driven opacity hovers near zero without ever reaching it.

## Choosing a configuration

| document                 | semantic margin            | interaction margin   | budget  | note                                                                                |
| ------------------------ | -------------------------- | -------------------- | ------- | ----------------------------------------------------------------------------------- |
| Decorative canvas        | `contentProjection: false` | —                    | —       | no DOM cost at all                                                                  |
| Short doc (< 300 blocks) | default                    | default              | 256     | default is already optimal                                                          |
| Long scrollable doc      | `Infinity`                 | default (1 viewport) | 256     | recommended resident tier — find + read-ahead over whole doc, carriers stay bounded |
| 10k-block transcript     | `Infinity`                 | `2 * viewport`       | 256–512 | wider interaction margin reduces promotion churn while scrolling                    |
| Particle / danmaku field | — (no content projection)  | —                    | —       | `a11yProjection: 'onDemand'` or aggregate `role: status` live region                |

`content-visibility: auto` and hover-gated text were both measured and rejected — see `forge/baselines/content-projection-frontload-findings.md:Two approaches rejected`. The former buys nothing over `display:none` for off-screen projections; the latter removes text for keyboard/AT users specifically.

## Gotchas — the bugs that already shipped

1. **Coarse→fine duplication** (`forge/findings/core-a11y-and-input.md:2026-08-08`) — a grid block promoted from coarse left its `textContent` text node behind while carriers were appended via `children`-only ops, doubling `textContent` (758 vs 379 chars measured). Fixed by stripping text nodes before the carrier loop (`ContentGridProjector.ts:111`).
2. **Selection past the window start** (`forge/findings/core-a11y-and-input.md:2026-08-08`, `ContentGridSelectionWindow.test.ts`) — scrolling past the _start_ of the window rebuilt the carrier without releasing the `Selection`, leaving it on a detached node. Needed `selectionLine < start || >= end` hoisted above the materialize loop.
3. **`pointerEvents: none` kills mouse** (`forge/findings/core-a11y-and-input.md:2026-08-02`) — see hotspot §; no warning, no error, just a dead scroll surface.
4. **Overlay re-projection lag** — `DirtyTracker` + `a11ySyncInterval` interaction with `showOverlay` was once suspected and then retracted as a backgrounded-browser artifact (`forge/findings/core-a11y-and-input.md:2026-08-16` retraction, `2026-08-15` original). The lesson: verify `document.hasFocus()` and an in-page rAF counter before attributing a frame-count delay to the Scene.
5. **Fixed-id collision** (`forge/findings/core-a11y-and-input.md:2026-07-16`, `vectojs#117`) — eleven `ui` components once called `super('ClassName')`, sharing one `a11yElements` map entry; two `PanelGroup`s routed pointer events to the wrong divider. Fixed by `super()` → random id.
6. **`a11yHidden` vs `interactive`** (`forge/findings/core-a11y-and-input.md:622`) — setting `interactive = false` on a container does not hide its still-interactive children; `a11yHidden` does.

## Automation — projection is also the input transport

A Playwright `getByRole('button', { name })` does not hit the canvas. It hits the shadow mirror in `a11yRoot`, and `Scene`'s per-mirror listeners (`Scene.ts:3512`) re-dispatch as `VectoJSEvent` (`Entity.ts:VectoJSEvent`) with `bubbles` and `stopPropagation` semantics. That is why the same `A11yAttributes.label` that an AT announces is also the selector an agent uses — no adapter, no `data-testid` needed. `debugA11y` plus `getA11yTree()` is the agent's assertion surface; `data-vecto-id` is the stable locator when the label is dynamic.

Consequence: an `onDemand` idle entity or an `a11yHidden` subtree has no mirror and therefore **no pointer dispatch path** — `scene.findEntityAt(x,y)` still returns the entity (query API), but `entity.on('click')` never fires. A global gesture surface that must stay pointer-reactive while AT-invisible uses `a11yFullViewport = true` + `a11yProjection: 'eager'` + `getA11yAttributes() => ({ tabIndex: -1 })` and no role — the mirror is focusable for pointer routing but has no AT name.

`a11yFullViewport` itself (`Entity.ts:912`) mounts one `100vw × 100vh` mirror behind all other mirrors (`A11yProjectionManager.ts:fullViewportElements` stays in insertion order) so a canvas-covering interaction surface never occludes on-top controls. The pattern is used by `DanmakuAnnouncer`, the webos desktop click catcher, and any infinite-canvas pan handler.

## What `getA11yAttributes` can project — the surface

`A11yAttributes` (`Entity.ts:295`) is the only a11y API a custom entity needs. Every field is dirtied per attribute per frame — `undefined` removes, `false` writes `aria-invalid="false"` (explicitly valid), so the distinction matters:

- **Identity**: `tag` (`div`/`a`/`button`/`img`/`input`/`textarea`), `role`, `label` / `labelledby` / `describedby`.
- **Focus/pointer**: `tabIndex` (see roving §), `pointerEvents` (`auto`/`none`).
- **Native props** (only for matching `tag`): `href`/`target`, `src`/`alt`, `inputType`/`placeholder`/`value`/`checked`/`textInputStyle`.
- **State**: `disabled`, `checked`, `selected`, `expanded`, `required`, `invalid`, `level`, `valuemin`/`valuemax`, `ariaModal`, `controls`/`haspopup`/`activedescendant`.
- **Virtualized set/grid**: `posInSet`/`setSize` (list), `rowCount`/`rowIndex`/`valueText`/`orientation` (grid) — without these a 10k-row virtualized list announces "item 3 of 12" (the window, not the dataset).
- **Live**: `live` (`off`/`polite`/`assertive`) + `atomic`/`relevant` — the streaming-announcer path (boss 04).

`getA11yAttributes()` default (`Entity.ts:1937`) returns `{}` → a plain `div` with no role, which is correct for a non-interactive text block that still needs a content projection.

## Performance numbers to quote (and where they were measured)

Only `benchmarks/run-browsers.sh` numbers on a focused, GPU-backed window are quotable (see global `AGENTS.md` benchmark rule). All figures below come from that harness unless noted. Use `calibrateRefreshRate()` — never hardcode 60/240 Hz (Firefox defaults to 60 Hz without `layout.frame_rate`). Cross-check `validation.ok`, `crossOriginIsolated`, and `refreshHz` in the JSON envelope — an unfocused window reports 0 ticks/s and every ms claim is void.

**Projection cost vs interactive count** — `content/learn/accessibility.md:353`, `Entity.ts:933`:

| condition                     | Chrome       | Firefox      | source                                                                             |
| ----------------------------- | ------------ | ------------ | ---------------------------------------------------------------------------------- |
| 1,000 moving interactive      | 6.4 ms/frame | 7.4 ms/frame | learn/accessibility §Cost + `lazy-a11y` floor                                      |
| 5,000 eager                   | 59.5–72.2 ms | 114 ms       | learn table + `benchmarks/lazy-a11y/` (`Entity.ts:933` doc)                        |
| 5,000 `onDemand` (same scene) | 1.55 ms      | 1.63 ms      | `benchmarks/lazy-a11y/` floor 1.26/1.65 ms                                         |
| 20,000 eager                  | 715 ms       | 2737 ms      | learn/accessibility table (super-linear: 6.4→35.7 µs/Chrome, 7.4→136.9 µs/Firefox) |

**Virtualization wins** — `forge/findings/core-a11y-and-input.md:240` (Gallery 346 KB Markdown, 172–238 Hz, real GPU):

| metric                  | before (no viewport gate)  | after                   |
| ----------------------- | -------------------------- | ----------------------- |
| DOM elements            | 14,843                     | 254                     |
| projected content nodes | ~1,250                     | 29 (recycles on scroll) |
| text nodes              | 9,369                      | 160                     |
| scroll p95              | ~50 ms                     | 4.3 ms                  |
| scroll frame            | 55 fps / 18 ms             | 238 fps / 4.2 ms        |
| heap                    | 125 → 224 MB during scroll | ~100 MB                 |

**Coarse semantic tier cost** — `forge/baselines/content-projection-frontload-findings.md: Finding 3` (Chrome 151 @ 240 Hz, Firefox 153 @ 240 Hz, `runId 20260804T155826Z-5cdf96`):

| blocks | lines  | `firstSyncMs` (hybrid vs native)                             |
| ------ | ------ | ------------------------------------------------------------ |
| 100    | 300    | 10.3 ms (1.6×) / 5.0 ms (1.1×)                               |
| 1,000  | 3,000  | 20.6 ms (4.5×) / 16.0 ms (5.3×) — ~one dropped frame at open |
| 10,000 | 30,000 | 146.6 ms (19.9×) / 144.8 ms (21.4×)                          |

Per-edit cost stays cheap (`editOffBand` 1.09/3.06 ms at 10k, `Finding 4`). Final budgeted drain after the `Selection`-memo fix (run `20260805T080824Z-e79819`, `forge/baselines/content-projection-frontload-findings.md:Two approaches rejected`): Chrome 21.29 → 10.66 ms at 1k and 139.5 → 12.0 ms at 10k; Firefox 21.86 → 5.88 ms and 141.6 → 9.2 ms. Per-block ~0.03 ms — the earlier ~13 µs/node figure was void (measured with `display:none` resident nodes that never entered layout).

## Debug checklist

1. **`scene.getA11yTree()` first.** Every hotspot and content node is there with `role`/`label`/`tabIndex` — if `getByRole` finds nothing, `interactive` or `width`/`height` is zero, not the selector (`Scene.ts:2390` guard, `content/learn/accessibility.md:Troubleshooting`). `a11yRoot` itself is excluded from the tree.
2. **`debugA11y: true`** (`SceneOptions:debugA11y`, `Scene.ts:204`) — blue dashed outlines over `a11yRoot`; fastest positional check. Mirrors are `opacity: 0` otherwise (`Scene.ts:2401` layer is `z-index: 10`, `pointerEvents: none` until drag). Toggle at runtime via `scene.debugA11y = true`.
3. **DOM inspection** — each mirror carries `data-vecto-id = entity.id` plus `role`/`aria-*`; check `aria-label` presence (role with no name is announced as bare "button"/"slider", `content/learn/accessibility.md:Screen reader testing checklist`). Content carriers carry `data-vecto-grid-*` and `data-vecto-projection-*` datasets. Use `document.querySelectorAll('[data-vecto-id]')` to count live mirrors vs expected.
4. **`scene.getA11yElement(entity.id)`** — the live `HTMLElement` for focus checks; `activeCellHoldsFocus` (`Table.ts:592`) pattern shows how to test it. `null` means not projected this frame (off-viewport, `a11yHidden`, or `onDemand` idle). Compare `scene.a11yElements.size` before/after `showOverlay` to catch overlay-projection regressions.
5. **`a11yProjection` gate check** — `onDemand` with no engagement has no mirror and thus no pointer events. Verify `Scene.requestA11yProjection` or focus state before blaming dispatch. Remember `findEntityAt` still works — it is not gated — so a canvas-level `pointerdown` handler would fire while the entity's own `on('click')` wouldn't.
6. **`pointerEvents` audit** — `grep -rn "pointerEvents.*none" packages --include="*.ts"` and confirm handler ownership. A silent scroll/selection failure is this more often than a clip bug. `ScrollView` at `ScrollView.ts:289` is the canonical wrapper-owns-none, child-owns-auto pair.
7. **Reading order** — dump `getA11yTree()` and verify band order matches visual rows. A misplaced `a11yRegion` shows up as a region-major ordering where band-major was expected (`A11yProjectionManager.ts:351` region bucketing).
8. **Selection / grid calibration** — `ContentProjectionManager.scheduleGridCalibration` writes per-cell `scaleX`; verify `data-vecto-grid-calib` generation. A stale generation after a font load means `contentFontEpoch` wasn't bumped. `content-visibility: auto` was measured and rejected (`forge/baselines/content-projection-frontload-findings.md:Two approaches rejected`); `contain: layout` on `a11yRoot` is intentional (`Scene.ts:2402`).
9. **Perf triage** — `PhaseTimer` phases `calibScan`/`calibProbeBuild`/`gridMaterialize` (`scene/PhaseTimer.ts`), `ContentGridProjector` `vectoGridMaterializeMs` dataset, `scene.frameStats` (`Scene.ts:518`), and DevTools `getDevtoolsDescriptor()` on `ScrollView`/`VirtualList`/`Table`. For quotable numbers, only `benchmarks/run-browsers.sh` on a focused window counts — backgrounded Hyprland gives `0 ticks/s` and every per-frame claim is void (`forge/findings/core-a11y-and-input.md:2026-08-16` retraction).

## How to verify virtualization is actually working

Three checks, in order:

1. **Count the DOM.** `document.querySelectorAll('[data-vecto-id]').length` vs `scene.a11yElements.size` vs the dataset size. A 10k-row virtualized Table should show ~`viewport/rowHeight + 2*overscan` mirrors, not 10k. If the number tracks the dataset, virtualization is off (`viewportHeight` not set, or `a11yProjection: 'eager'` on every row entity instead of the windowed pool).
2. **Scroll and recount.** The set should recycle — same count, different `data-vecto-id`s as the window moves. A growing count means leaked mirrors (`detachA11y` not called on unmount, or a pool that grows without shrinking — check `Table.ts:701` shrink loop and `VirtualList.ts:_reconcile` recycle branch).
3. **Perf envelope.** `scene.frameStats` (`Scene.ts:518`) + `benchmarks/run-browsers.sh --validation` on a focused window. If scroll p95 stays >10 ms after virtualization, the cost is no longer DOM count — check `PhaseTimer` grid calibration or the `syncA11y` walk itself (`O(total entities)` without `viewportCullChildren`, `vectojs#350`).

## Where this boss sits in the doc graph

- **Prereq**: Boss 06 (VMT runtime — dirty/lifecycle/events, `DirtyTracker`, `DriverTicker`, `Scene` loop). This boss reuses 06's dirty/lifecycle machinery and assumes you know the VMT step.
- **Pairs with**: Boss 01 (Selection — the other consumer of content projection), `content/learn/accessibility.md` (how-to), `content/reference/core-a11y.md` (API truth), `content/reference/core-entity.md` (`A11yAttributes` surface, `getA11yAttributes`/`getContentProjection`/`getContentEpoch` hooks).
- **Leads to**: Boss 04 (Streaming Markdown — `Markdown` virtualization handshake + incremental reconcile that reuses this boss's windowing), Boss 07 (Renderer — clip/DPR consistency for the visual tier), Boss 12 (DevTools — `getDevtoolsDescriptor` surfaces for virtualization state).

No `cp -r` between `vectojs-docs/content` and `vectojs-website/src/content` — formatting drift + 408 i18n files (`AGENTS.md`). Edit the authoritative side (`vectojs-docs/content`) first, preview with `scripts/sync-content.py`, then push both repos.

## Invariants (the commit checklist for this boss)

1. **Dirty + geometry agree.** `getContentEpoch()` bumps whenever `getContentProjection()` output would differ; `Scene` skips unchanged blocks from the second sync onward. Breaking this pays `O(total blocks)` per frame instead of `O(changed)`. No `content-visibility` shortcut — it was measured and rejected. `onDemand` idle entities are not dirty by definition.
2. **Dual-world parity for every visible interactive.** World geometry, role/name/state, and focus/pointer routing match the canvas truth — enforced by the shared `syncA11y` walk and `enforceA11yDomOrder`'s per-region visual sort. One `interactive = false` vs `a11yHidden` slip projects a hidden control into tab order. Every interactive carries `aria-label` unless its accessible name comes from `aria-labelledby` / contained text. `a11yFullViewport` mirrors are always behind normal mirrors.
3. **Contiguous windowing.** The line grid windows are a single contiguous run per block (`scene/content-line-window.ts:Contiguous on purpose`) — a gap would splice text out of selection/copy order. `clipChildren`/`a11yRegion` are the only region breaks. The split between semantic and interaction margins is the whole API — don't collapse them.
4. **Pointer owner is explicit.** Every hotspot pair declares who owns the pointer; tests that drive entities directly won't catch a `pointerEvents: 'none'` that silenced a mouse path (`forge/findings/core-a11y-and-input.md:336`). `onDemand` without engagement is pointer-dead by design — use `a11yFullViewport` + `eager` + `tabIndex: -1` for an AT-invisible pointer surface.
5. **Reading order is visual, not insertion.** `A11yProjectionManager.sortNormalElementsVisually` + region bucketing is the tab/AT order; inserting children in any order but drawing left→right must still tab left→right. `a11yHidden` is never inferred from opacity. `forcedColors` (`Scene.forcedColors`) is a repaint concern, not a projection one — high-contrast drawing stays in the visual tier.
6. **Budget does not hide visible text.** `contentSemanticBudget` never delays a block inside the interaction band — deferring visible text would make it briefly unselectable (`Scene.ts:376`). The guarantee is tested by `ContentProjectionSettledWalk.test.ts` (2 vs 802 box tests). `Infinity` is safe for `contentSemanticMargin` and forbidden for `contentProjectionMargin` — the cost that made it unsupported was an unwindowed carrier band, not resident text.
7. **Virtualized sets announce dataset size.** A virtualized list/grid with 10k items but 12 mounted rows must project `posInSet`/`setSize` (or `aria-rowcount`) so AT hears "item 400 of 10000", not "item 3 of 12". Container-level `aria-setsize` on `role="list"` is disallowed (`VirtualList.ts:660`).

## Further reading — every claim pinned

| claim                       | `file:line`                                                                                                                                                                                         |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Scene options / budget      | `Scene.ts:204`, `263`, `328`, `336`, `359`, `600`, `1398`, `1481`, `2403`, `3512`                                                                                                                   |
| Entity a11y + content hooks | `Entity.ts:295`, `788`, `912`, `968`, `1898`, `1970`, `2018`, `2048`                                                                                                                                |
| Projection managers         | `A11yProjectionManager.ts:30`, `157`, `169`, `178`, `351` · `ContentProjectionManager.ts:26` · `ContentGridProjector.ts:69` · `content-line-window.ts:25`                                           |
| UI virtualization           | `ScrollView.ts:58`, `233`, `289` · `VirtualList.ts:14`, `117`, `170`, `660` · `Table.ts:144`, `392`, `624`, `751` · `Card.ts:80`                                                                    |
| Markdown tiling             | `Markdown.ts:625`, `652`, `681`, `774`                                                                                                                                                              |
| Findings / baselines        | `forge/findings/core-a11y-and-input.md:178`·`240`·`336` · `forge/baselines/content-projection-frontload-findings.md:1` · `content/learn/accessibility.md:353` · `content/reference/core-a11y.md:10` |
| Hotspot precedent           | `vectojs/AGENTS.md` (Zero-DOM hotspot) · PR #160 · PR #191 · `Table.ts:56`                                                                                                                          |

---

_Next: 04 Streaming Markdown — incremental lex, worker + reconcile, and the `Markdown`↔`ScrollView` virtualization handshake._
