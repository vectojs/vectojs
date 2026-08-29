---
title: "14 — Responsive Layout & Interaction — Adapting to Viewport & Input"
description: "Viewport as constraint: resize/zoom reflow, Stack/Flow layout passes, panel dashboards, VirtualList windowing, ScrollView physics, ResizablePanel handles, overlay placement, and hover/focus states — all in VectoJS's canvas-native world."
order: 34
---

# 14 — Responsive Layout & Interaction — Adapting to Viewport & Input

> In a DOM browser, responsive layout is CSS: media queries, flexbox, grid, and scroll containers the engine gives you for free. In VectoJS, there is no CSS engine — every pixel is arithmetic over a retained entity tree on a single `<canvas>`. The viewport is just another number that invalidates caches, a scroll offset is a spring-driven `y`, and an overlay is an entity re-parented to `overlayRoot` with an explicit placement computation. This document is how those numbers stay consistent when the window resizes, the user zooms, or a finger drags a panel divider.

- **What you'll learn**: how `Scene.resize()` propagates a viewport change through renderer backing stores, projection tiers, and layout passes; how `Stack`/`Flow`/`Card`/`PanelGroup` compose responsive dashboards without a CSS engine; how `VirtualList` windows 10k rows into ~15 mounted entities; how `ScrollView` spring physics, `ResizablePanel` drag handles, `Overlay` placement flipping, and `Button` hover/focus rings close the interaction loop — all with file:line receipts.
- **What you won't**: VMT lifecycle/dirty/event dispatch (boss 06), text shaping and line breaking (boss 02), semantic projection (boss 03), or streaming Markdown diffing (boss 04).

## 1. The viewport is a constraint, not a container

### 1.1 Scene.resize() — the single source of truth

`Scene.resize(width, height)` at `packages/core/src/tree/Scene.ts:6381` is the viewport boundary:

```ts
public resize(width: number, height: number): void {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 0 || height < 0) {
    if (!this.hasWarnedInvalidResize) console.warn(`...`); return;
  }
  this.width = width; this.height = height;
  this.contentFontEpoch++; this.contentViewportEpoch++;
  (this.renderer as any).resize(width, height);
  if (this.pointRenderer) { this.pointRenderer.resize(width, height); }
  if (this.gpuCanvas) this.sizeGpuCanvas(this.gpuCanvas, width, height);
  this.markDirty();
}
```text

Five things happen atomically: logical `width`/`height` update, two generation counters bump, every backing store resizes, and the frame is dirtied. The generation counters are the key — `contentFontEpoch` forces text recalibration (browser zoom changes Range geometry even at the same CSS font), and `contentViewportEpoch` re-tiers every content block without moving any of them (`Scene.ts:6415`, `Scene.ts:6420`). A resize that only changed `width`/`height` would leave every block holding DOM built for the old viewport.

Invalid dimensions are rejected, not clamped (`Scene.ts:6382`): storing `-10` while the canvas element clamps to `0` would make culling and a11y geometry disagree. The warning is latched (`hasWarnedInvalidResize` at `Scene.ts:2113`) because `ResizeObserver`-driven callers would spam every drag frame.

### 1.2 Who calls resize()

Two paths, split by `disableWindowResize` (`Scene.ts:268`, `Scene.ts:2051`):

| Mode                                                   | Observer                                                                                 | Handler                                                     |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| Window-filling (`disableWindowResize: false`, default) | `window` `resize` listener (`Scene.ts:2968`) + DPR media-query/watcher (`Scene.ts:3052`) | `resize(window.innerWidth, window.innerHeight)`             |
| Embedded (`disableWindowResize: true`)                 | `ResizeObserver` on `canvas` (`Scene.ts:3082`)                                           | `resize(entry.contentRect.width, entry.contentRect.height)` |

Plus explicit caller-driven `scene.resize(w, h)` for custom containers — the only path when `ResizeObserver` is unavailable (`Scene.ts:2740` guard). DPR scaling is orthogonal: `maxDPR` (`Scene.ts:287`) caps the backing-store multiplier, so a DPR-3 display renders at 2x rather than 3x (`logical size × dpr²` cost, `Scene.ts:276`).

### 1.3 Zoom is a resize

Browser zoom fires `window.resize` and changes `devicePixelRatio`. Scene's DPR watcher (`Scene.ts:1435` `dprMediaQuery`, `Scene.ts:1441` `dprPollInterval`) re-invokes `resize(this.width, this.height)` — same logical size, new backing-store scale — and the `contentFontEpoch++` in that path handles Range-geometry drift on Firefox fractional scales (`Scene.ts:6410` comment).

## 2. Layout containers — from stack to dashboard

### 2.1 Stack — the primitive

`Stack` at `packages/ui/src/Stack.ts:59` is VectoJS's flexbox: sequential on one axis, cross-axis `align: 'start'|'center'|'end'` (`Stack.ts:17`), `gap` (`Stack.ts:14`), optional `wrap` with `maxWidth`/`maxHeight` (`Stack.ts:19`), and `fillTarget` for fill-remaining layouts (`Stack.ts:42`).

`layout()` at `Stack.ts:303` is a two-pass algorithm:

- **Pass 1 — grouping** (`Stack.ts:325`): when `wrap` is true, scan children along the main axis, cutting a new line whenever `currentMain + gap + childMain > limit`. Otherwise one line holds all children.
- **Pass 1.5 — fill** (`Stack.ts:349`): when `fillTarget` is set and wrap is off, stretch the last child so `children + gaps == fillTarget` — floored at content size, never shrinking.
- **Pass 2 — placement** (`Stack.ts:371`): for each line compute `lineCross`/`lineMain`, then assign `x`/`y` with cross-axis alignment offsets (`Stack.ts:388`).

`Stack` is a pure structural container — `render()` draws nothing (`Stack.ts:443`), only its children paint. Its own `width`/`height` size to the laid-out content, enabling culling. `getLayoutControlledProperties()` at `Stack.ts:163` returns `['x','y']` — writes to children are reverted on the next layout.

Two O(1) fast paths avoid the O(n) full layout on streaming append (`Stack.ts:167` `add()`, `Stack.ts:257` `appendFastWrap()`):

- `appendFast()` (`Stack.ts:231`) — non-wrap, `align: 'start'`: place the single new child at `height + gap` (vertical) or `width + gap` (horizontal) and grow the container's cross size. Earlier children are unaffected under start alignment.
- `appendFastWrap()` (`Stack.ts:257`) — wrap + `align: 'start'`: place on the current line or start a new one, using only four scalars of last-line state (`Stack.ts:95` `wrapLineMain/Cross/PriorCross/MaxMain`), never re-walking.

Both fall back to `layout()` when `align !== 'start'`, `fillTarget` is set, or `fastAppendDirty` (set by `remove()` at `Stack.ts:184`).

For streaming text that grows without `add()`/`remove()`, `resizeLastChild(child)` at `Stack.ts:210` handles in-place last-child growth as `height = child.y + child.height` / `width = max(width, child.width)` — only valid when the child's cross size grows, not shrinks.

### 2.2 Flow — chip rows for free

`Flow` at `packages/ui/src/Flow.ts:19` is one line:

```ts
export class Flow extends Stack {
  constructor(opts: FlowOptions = {}) {
    super({ ...opts, direction: opts.direction ?? "horizontal", wrap: true });
  }
}
```text

### 2.3 Card — the rounded panel

`Card` at `packages/ui/src/Card.ts:49` is a fixed-size rounded box (`Card.ts:123` `roundRect` + `fill`/`stroke`). With `label` it projects `role="group"` (`Card.ts:81`); with `onClick` it becomes clickable — requiring `label` so the a11y projection always gets an accessible name (`Card.ts:71` throws otherwise, `vectojs-docs/forge/findings/ui-components.md:43` origin). `setContent(entity, fit?)` at `Card.ts:92` mirrors `Panel.setContent` — by default the content tracks the card's `width`/`height` via `update()` (`Card.ts:118`).

### 2.4 PanelGroup — the dashboard lattice

`PanelGroup` at `packages/ui/src/ResizablePanel.ts:213` splits available space among `Panel` children with draggable `PanelResizeHandle` dividers:

```text
PanelGroup { direction, width, height }
  ├── Panel { minSize, defaultSize, clipChildren: true }  — setContent(entity, fit?)
  ├── PanelResizeHandle { width: handleSize, interactive: true }  — drag delta → _onResize
  ├── Panel
  └── ...
```text

`addPanel()` at `ResizablePanel.ts:237` auto-inserts a handle before every panel after the first (`ResizablePanel.ts:239` `new PanelResizeHandle`). `resize(w, h)` at `ResizablePanel.ts:258` redistributes sizes proportionally (`ResizablePanel.ts:267` `(size / basis) * avail`) then normalizes (`ResizablePanel.ts:309` clamp to `minSize`/`avail`). `_layout()` at `ResizablePanel.ts:343` assigns `x/y/width/height` to panels and handles alternately — a horizontal group's panels are `width = sizes[i], height = cross`; handles are `width = handleSize, height = cross`.

`Panel.setContent()` at `ResizablePanel.ts:164` keeps content sized to the panel's box by default (`fit: true`, `ResizablePanel.ts:7` `FitContentOptions`), re-applied every frame from `Panel.update()` (`ResizablePanel.ts:190`) — necessary because `Entity.width/height` are plain fields with no setter hook (`ResizablePanel.ts:158` contract note, `vectojs-docs/forge/findings/ui-components.md:15` origin fixed in `@vectojs/ui@1.11.0`).

`PanelGroup` nesting composes: a `PanelGroup` as a `Panel`'s content (`Panel.setContent(innerGroup)`) yields nested splits — the inner group's `update()` keeps it sized to the outer panel, no extra wiring.

## 3. VirtualList — windowing 10k rows into ~15 entities

### 3.1 The Fenwick spine

`RowHeights` at `packages/ui/src/VirtualList.ts:14` is a Fenwick (binary-indexed) tree over per-row heights (`VirtualList.ts:17` `Float64Array` of size `n+1`):

- `total()` (`VirtualList.ts:46`) — O(1) sum of all row heights.
- `prefix(i)` (`VirtualList.ts:60`) — O(log n) y of row `i`'s top.
- `indexAt(y)` (`VirtualList.ts:71`) — O(log n) first row whose bottom exceeds `y`, via binary lifting.
- `set(i, h)` (`VirtualList.ts:51`) — O(log n) point update with delta propagation.

Every row starts at `estimatedRowHeight` (`VirtualList.ts:28`); `set()` replaces the estimate when the row mounts and is measured.

### 3.2 Reconciliation — only the visible window

`VirtualList` at `VirtualList.ts:179` keeps `this._pool: Map<number, Entity>` (`VirtualList.ts:203`) — one entity per mounted row index, not per data item.

`_visibleRange()` at `VirtualList.ts:468` derives `[start, end]` (inclusive) from `_scrollY` and `height` via two `indexAt` calls, expanded by `overscan` (default 3, `VirtualList.ts:103`) on both ends. `_reconcile()` at `VirtualList.ts:488`:

1. Recycle out-of-range entities (`VirtualList.ts:494` `super.remove` + `delete`).
2. Mount newly visible rows (`VirtualList.ts:506` `renderItem(item, i)`, `super.add`).
3. Measure after mount (`VirtualList.ts:515` `_measureMountedRows` before positioning — reading `heightOf(i)` before placement prevents the one-frame stale-offset that preceded PR #509).
4. Position `y = rowTop(s) + ... - _scrollY` (`VirtualList.ts:518`).

`VirtualList.scrollToIndex(i)` / `scrollToTop/Bottom` / `jumpToBottom` at `VirtualList.ts:342` retarget `_targetY`/`_scrollY`; `jumpToBottom` snaps instantly (zero velocity) for streaming transcripts where retargeting an integrator every chunk never lets it settle.

### 3.3 Growth, identity, and anchoring

Without `keyForItem`, `setItems()` at `VirtualList.ts:248` clears the height cache and jumps to top — correct for a replaced list, wrong for a growing transcript. With `keyForItem` (`VirtualList.ts:117`):

- `_heightByKey: Map<string, number>` (`VirtualList.ts:199`) survives `setItems` — measured heights are a property of the row, not its index (`VirtualList.ts:272` re-seed from cache after tree rebuild).
- `_rekeyPool()` at `VirtualList.ts:317` moves pooled entities to their new indices before any height read — without it a prepend overwrites every entry with the wrong height.
- Scroll anchoring (`VirtualList.ts:397` `_captureAnchor` / `VirtualList.ts:431` `_restoreAnchor`): two variants — `bottom` (distance-to-bottom, preserved gap) when `nearBottom` (`VirtualList.ts:219` latched per scroll), `item` (anchored row key + offset within) otherwise. A resize that changes every row's height leaves the anchored row visually still.

`_measureMountedRows()` at `VirtualList.ts:540` polls every mounted row's `height` each frame, applies the delta via `Fenwick.set`, and anchoring — handling rows that resize after mount (streaming Markdown reflow, direct `height` assignment) without any setter hook.

## 4. ScrollView — one viewport, one spring

`ScrollView` at `packages/ui/src/ScrollView.ts:58` is the non-virtualized counterpart: a clipped viewport (`ScrollView.ts:71` `clipChildren = true`) whose inner `content` entity slides on `y` via the shared spring system (`ScrollView.ts:90` `content.setTransition({ y: scrollPhysics ?? 'spring' })`).

- **Wheel** (`ScrollView.ts:92`): `deltaMode` conversion (`ScrollView.ts:105` pixels/lines×16/pages×viewport), `targetY -= delta`, clamp, `content.y = targetY` retargets the spring preserving velocity. Ctrl+wheel bails to let the browser zoom; content that fits (`maxScroll <= 0`) bails to avoid a dead strip (`ScrollView.ts:95`, fixes #525).
- **Pointer drag** (`ScrollView.ts:113`): 1:1 finger tracking via `localY` deltas.
- **Clamping** (`ScrollView.ts:136`) via `clampTarget()` keeps `targetY ∈ [-maxScroll, 0]`. `update()` at `ScrollView.ts:219` defensively re-clamps and only re-assigns `content.y` when the clamp actually moved — unconditional re-assignment would spawn a spurious done-driver forever, defeating the idle throttle (`ScrollView.ts:217` comment).
- **`scrollToBottom()`** (`ScrollView.ts:163`) snaps via `jumpTo()` (`ScrollView.ts:79` `setImmediate('y', y)`) rather than retargeting the spring — callers streaming chat call it many times per second, and a spring retargeted that fast never settles and jitters.
- **`DOCUMENT_SCROLL_PHYSICS`** at `ScrollView.ts:36` (`{ stiffness: 180, damping: 27 }`, ζ ≈ 1.006, `vectojs-docs/forge/findings/ui-components.md:241` origin) is the critically-damped preset for document scrolling; defaults (`stiffness: 180, damping: 12`, ζ ≈ 0.447) overshoot by ~20% and bounce — lively on a list, wrong on a document.
- **Content growth** (`ScrollView.ts:233` `driveVirtualizableContent`): polls children's extents each frame and resyncs via `updateContentSize()` when they differ — handling streaming `setSpans` growth without `add()`/`remove()`. `ScrollVirtualizable.setVisibleRange` (`ScrollView.ts:50` duck-typed) is driven the same frame for windowed content.

## 5. Interaction primitives

### 5.1 ResizablePanel handles — scene-space deltas

`PanelResizeHandle` at `packages/ui/src/ResizablePanel.ts:42` measures drag deltas in **scene space** (`ResizablePanel.ts:86` `posOf` prefers `sceneX`/`sceneY` over `localX`/`localY`). The handle moves with the panel it resizes, so local coords barely change as the panel grows and the handle slides under the cursor — scene coords are stable, so 1px travel = 1px resize (`ResizablePanel.ts:78` comment, `vectojs-docs/forge/findings/ui-components.md:64` origin, fixed in `@vectojs/ui@1.1.3`). `hover` swaps `color` → `hoverColor`; the handle is `interactive: true` with `pointerdown`/`pointermove`/`pointerup`/`pointerleave` wiring (`ResizablePanel.ts:92`).

### 5.2 Overlay — floating content above the tree

`Overlay` at `packages/ui/src/Overlay.ts:37` is the base for `Tooltip`, `Popover`, `ContextMenu`:

- Mounts to `scene.overlayRoot` (`Overlay.ts:168` `scene.overlayRoot.add(this)`) — above `clipChildren`, always on top.
- Placement (`Overlay.ts:14` `OverlayPlacement`: `top|bottom|left|right|auto` plus `-start/-end` variants) computed in `_position()` at `Overlay.ts:171` from `target.getWorldBounds()` + `placement` + `offset` (default 6, `Overlay.ts:23`), then clamped via `_placeAt()` at `Overlay.ts:227` to `4px` viewport margin. `auto` flips based on available space below vs above (`Overlay.ts:180`).
- `showAtPoint(x, y, source?)` at `Overlay.ts:98` accepts an optional `source` (Scene or mounted Entity) to resolve `scene` when the overlay itself has never been mounted — otherwise it silently no-ops on first call (`vectojs-docs/forge/findings/ui-components.md:114` origin, fixed in `@vectojs/ui@1.10.0`).
- Entrance via `setTransition` on `opacity/scaleX/scaleY` (`Overlay.ts:59` `easeOutQuad` + spring) and `a11yHidden`/`interactive` toggling that hides the subtree from both pointer hit-testing and a11y projection (`Overlay.ts:149` `hide()` also calls `detachA11y`).
- `Modal` at `packages/ui/src/Modal.ts:25` builds on this: a full-viewport backdrop (`Modal.ts:40` `width = window.innerWidth`, `Modal.ts:39` `a11yFullViewport = true`) with a centered `Card` that springs in via `card.scaleX/scaleY` (`Modal.ts:84` seed 0, `Modal.ts:266` `springTo({scaleX:1,scaleY:1})`), focus-trap and Escape handling (`Modal.ts:188` `installFocusTrap`), and `close()` at `Modal.ts:282` that animates out before `scene.hideOverlay(this)` and focus restore.

### 5.3 Hover / focus — the canvas feedback loop

A canvas has no `:hover` or `:focus-visible`. VectoJS drives them from a11y-projection events that Scene re-dispatches into the VMT:

- **Hover** — `Button` at `packages/ui/src/Button.ts:97` `on('hover')` / `on('pointerleave')` toggles `hovered` → repaints with `hoverBg` (`Button.ts:11` option), gated by `disabled` so a disabled affordance never looks active. `PanelResizeHandle` does the same at `ResizablePanel.ts:111` for `hoverColor`.
- **Focus ring** — `Button.focused` at `packages/ui/src/Button.ts:61` strokes a 2px `focusColor` ring (`Button.ts:30` default `#00f0ff`). The flag is driven from real DOM `focus`/`blur` on the shadow `<button>` that Scene emits when the a11y element focuses — without this the canvas ring never appears for keyboard users.
- **Caret blink** — `UIComponent.startCaretBlinkWake()` at `packages/ui/src/UIComponent.ts:84` schedules a 500 ms wake-up (`markDirty` at the next phase boundary) so an idle `onDemand` scene still blinks the caret in `Input`/`TextArea` — one timeout per phase costs ~2 renders/s while focused (`UIComponent.ts:76` comment), vs pinning the scene at full rate.
- **Focus trap** — `Modal` (`Modal.ts:188`) and `Overlay` hide/show keep `a11yHidden` and `interactive` in lockstep so a hidden popover's button does not stay Tab-reachable (`vectojs-docs/forge/findings/ui-components.md:391` origin, fixed in 2026-08-13 P2 batch).

The general rule: every visual state that a browser would derive from CSS pseudo-classes must be driven explicitly from the a11y-projection's live DOM events, and every hide must drop both the visual and the projection.

## 6. Responsive patterns without a CSS engine

### 6.1 The resize cascade for an app shell

```ts
// One such handler owns the whole responsive cascade:
window.addEventListener("resize", () => {
  const w = window.innerWidth,
    h = window.innerHeight;
  scene.resize(w, h);
  header.width = w;
  header.layout();
  sidebar.height = h - header.height;
  sidebar.layout();
  contentGroup.resize(w - sidebar.width, h - header.height);
});
```text

Each `resize()` bumps the two generation counters, every backing store rescales, `Stack`/`Flow` re-group on the next `layout()`, `PanelGroup.resize()` redistributes, and `VirtualList` clamps `_targetY` (`VirtualList.ts:566` `_clamp`). No media-query engine — the app decides the breakpoint and calls the API.

### 6.2 Panel dashboards — nested splits

`PanelGroup` nesting (`ResizablePanel.ts:206` doc) is the idiomatic IDE/editor shell:

```ts
const outer = new PanelGroup({ direction: "horizontal", width: W, height: H });
const sidebar = new Panel({ minSize: 160, defaultSize: 0.2 });
const editorGroup = new Panel({ minSize: 300 }); // hosts inner vertical split

const inner = new PanelGroup({ direction: "vertical", width: 0, height: 0 });
inner.addPanel(new Panel({ defaultSize: 0.6 })); // editor
inner.addPanel(new Panel({ minSize: 120 })); // terminal
editorGroup.setContent(inner); // ← Panel.setContent keeps inner sized

outer.addPanel(sidebar).addPanel(editorGroup);
scene.add(outer);
// On window resize: outer.resize(newW, newH) — inner follows via Panel.update().
```text

`PanelGroup.resize()` proportional scaling (`ResizablePanel.ts:265`) handles the outer group; the inner group is re-laid out via `Panel.update()`'s fit sync, no explicit inner `resize()` call needed.

### 6.3 ScrollView vs VirtualList — when to window

| Need                                         | Use                                                               | Why                                                                                           |
| -------------------------------------------- | ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Document / chat transcript, unbounded height | `ScrollView` + `Stack`                                            | Simple, spring-animated, content growth polling handles streaming                             |
| Long list with 100+ uniform rows             | `VirtualList`                                                     | Only ~15 entities mounted, Fenwick scroll math O(log n), heights survive `setItems` with keys |
| Long list with variable row heights          | `VirtualList` + `estimatedRowHeight`                              | Estimates on first mount, measured heights replace them and anchor the viewport               |
| Chat with streaming bottom-pinned growth     | `VirtualList` + `jumpToBottom()` or `ScrollView.scrollToBottom()` | Snapping, not spring-retargeting, keeps the viewport still                                    |

### 6.4 Scrollbar visibility — `clip-overflow` vs real scrollbar

VectoJS has no native scrollbar widget — `ScrollView` and `VirtualList` clip and handle wheel/drag themselves, and the a11y shadow preserves reading order. A visual scrollbar (DevTools audit `clip-overflow` at `packages/devtools/src/audit.ts:51`, exempt for `ScrollView`/`VirtualList`/`Tree`/`Table`) is a decorative `Rect` whose thumb `y` tracks `scrollY / maxScroll` — not a separate interactive target.

## 7. Hard parts — with receipts

| Pitfall                                                                 | Where                                                       | Status                                                                          |
| ----------------------------------------------------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Container never sizes its content (`Tabs`/`Panel`/`PanelGroup` chain)   | `ResizablePanel.ts:164`, `Card.ts:92`, forge 2026-07-10     | Fixed `@vectojs/ui@1.11.0` — `setContent(entity, fit?)` with per-frame fit sync |
| Whole-card click needed invisible overlay Button                        | `Card.ts:35`, forge 2026-07-10                              | Fixed `@vectojs/ui@1.11.0` — `Card({ onClick, label })`                         |
| Panel drag used local-space deltas (lagged cursor)                      | `ResizablePanel.ts:78`, forge 2026-07-10                    | Fixed `@vectojs/ui@1.1.3` — scene-space `sceneX`/`sceneY`                       |
| Tabs collapsed to slivers past ~10 tabs                                 | forge 2026-07-10                                            | Fixed `@vectojs/ui@1.1.3` — fixed `tabWidth` + overflow scroll                  |
| Tabs stretch × visually next to the NEXT tab's label                    | `Tabs._tabW()`, forge 2026-07-16                            | Fixed `@vectojs/ui@1.9.4` — `tabWidth` is max, surplus empty                    |
| Overlay.showAtPoint silently no-ops before first mount                  | `Overlay.ts:98`, forge 2026-07-17                           | Fixed `@vectojs/ui@1.10.0` — `source` arg for scene resolution                  |
| Stack.add() is O(n²) on streaming                                       | `Stack.ts:167`, `Flow.ts:19`, forge 2026-07-19              | Fixed `@vectojs/ui@1.11.4` — `appendFast`/`appendFastWrap`                      |
| ScrollView default spring is underdamped (5 reversals, 801 ms)          | `ScrollView.ts:14`, forge 2026-08-02                        | Fixed `@vectojs/ui` #322 — `scrollPhysics` + `DOCUMENT_SCROLL_PHYSICS`          |
| VirtualList unkeyed setItems left stale rows on screen                  | `VirtualList.ts:248`, forge 2026-08-02/08                   | Fixed `@vectojs/ui@2.15.1`                                                      |
| Scroll widgets ignore deltaMode (line/page wheels scroll 1-3 px)        | `ScrollView.ts:105`, `VirtualList.ts:583`, forge 2026-08-08 | Fixed `@vectojs/ui@2.15.2`                                                      |
| deltaMode fix dropped VirtualList markDirty (froze onDemand)            | `VirtualList.ts:596`, forge 2026-08-08                      | Fixed `@vectojs/ui@2.15.3`                                                      |
| Popover + Overlay a11y/pointer leak while hidden                        | `Overlay.ts:48`, forge 2026-08-13                           | Fixed vectojs#474, merged vectojs#509                                           |
| Virtualized Table does not re-sync string cells on layout()             | `Table.ts:354`, forge 2026-08-13                            | Fixed vectojs#494, merged vectojs#520                                           |
| Tabs/RadioGroup hotspots desync on array reassignment                   | `Tabs.ts:229`, forge 2026-08-13                             | Fixed vectojs#494, merged vectojs#520                                           |
| Non-keyed VirtualList setItems leaves stale _velY (transient overshoot) | `VirtualList.ts:290`, forge 2026-08-13                      | Fixed vectojs#494, merged vectojs#520                                           |

## 8. Checklist — before you land a responsive-layout change

1. **Call scene.resize() when the logical viewport changes.** Logical `width`/`height` are plain fields (`Scene.ts:2049`) — nothing observes them until `resize()` bumps the two generation counters and rescales backing stores. Check both `disableWindowResize: false` (window path) and `true` (ResizeObserver path). Guard with the `Number.isFinite && >= 0` check (`Scene.ts:6395`).
2. **Keep container sizing symmetric.** Every container that owns children's `width`/`height` must re-apply via `update()` (the `Panel`/`Card` pattern at `ResizablePanel.ts:190` / `Card.ts:118`) because `Entity.width/height` are plain fields with no setter hook. Grep for direct `children.push` outside `Entity.ts:1065 add()` — it skips `markStructureChanged` and `markDirty` entirely.
3. **Stack fast paths must stay under the invariant.** Non-wrap `appendFast` assumes `align: 'start'` and no `fillTarget`; wrap `appendFastWrap` restores four scalars last-line state (`Stack.ts:95`) and recomputes from lines after a full `layout()` (`Stack.ts:422`). A new flag that lets a later child affect earlier positions must invalidate `fastAppendDirty`.
4. **Overlay ownership is overlayRoot, not parent.** `Overlay.showAt` (`Overlay.ts:70`) re-parents to `scene.overlayRoot` — always pass `source` from `showAtPoint`'s caller (`Overlay.ts:98` third arg) so a never-mounted overlay resolves `scene` on first show.
5. **Scroll integrators must not re-arm the idle throttle.** `ScrollView.update()` (`ScrollView.ts:219`) only re-assigns `content.y` when clamping moved `targetY`; `VirtualList` does `markDirty()` only when scroll state changes (`VirtualList.ts:596`). Unconditional per-frame dirtying keeps an `onDemand` scene at full rate forever.
6. **deltaMode — scale before you clamp.** Line→×16, page→×viewport before `clampTarget()`/`_clamp()` (`ScrollView.ts:105`, `VirtualList.ts:583`). Chrome/jsdom always deliver `deltaMode: 0`, so the bug is invisible there.
7. **VirtualList: rebuild heights from keys, not indices.** After `setItems` with `keyForItem`, the Fenwick tree re-seeds from `_heightByKey` (`VirtualList.ts:272`) and ` _rekeyPool()` (`VirtualList.ts:317`) moves pooled entities before any height read — index-addressed reuse without rekeying writes every height into the wrong cache slot.
8. **PanelDrag must stay in scene space and not end on pointerleave.** `PanelResizeHandle` (`ResizablePanel.ts:86`) reads `sceneX`/`sceneY` when available, and no longer ends drag on `pointerleave` — the shadow node holds capture.

---

_Series: 00 Overview → 01 Selection → 02 Text+Layout → 03 Semantic Projection → 04 Streaming Markdown → 05 TeX → 06 VMT Runtime → 07 Renderer → 08 WASM → 09 Three/XR → 10 Video Export → 11 Graph Layout → 12 DevTools → **14 Responsive Layout** → 99 Synthesis._
