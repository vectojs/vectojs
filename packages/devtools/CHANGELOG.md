# @vectojs/devtools

## 0.11.1

### Patch Changes

- 0e8dfd0: Four P2 fixes from the 2026-08-13 code review: snapshot diffing no longer pairs a node twice or drops removals on mixed keyed/unkeyed sibling levels; armed pick mode ignores clicks on the panel's own controls instead of consuming them; `findEntityAt` now applies the engine's opacity, clip-ancestor, and pointer-transparent rejection gates so the inspector picks what a click would hit; a11y canvas-vs-DOM drift comparison normalizes the projected node's client rect back to scene units (CSS-scaled canvases no longer report false drift).
- ec78b38: P3 fixes from the 2026-08-13 review (#495, #496):

  - `MSDFFont.layout` no longer replaces the kerning base with a combining mark: `prevCode` stays on the base glyph, so a kern pair like A→B still applies across `A\u0301B` instead of being silently dropped.
  - `createCanvasMeasurer.measure()` honors the `GlyphMeasurer` contract for per-run `fontFamily`/`bold`/`italic` overrides — it now measures (and caches) at the requested style instead of always returning base-font numbers, so inline `monospace`/bold runs break lines by their own metrics.
  - `LayoutEngine.layoutPreparedIntoBuffer` honors `preserveLeadingSpaces` like the allocating path; the zero-GC path previously skipped leading whitespace unconditionally.
  - `TweenDriver` sanitizes non-finite `duration`/`delay` (NaN config no longer wedges the value at NaN with `isDone()` forever false) and snaps to `to` exactly when complete, so a custom `EasingFn` with f(1) !== 1 can no longer finish off-target.
  - `SpringDriver` drops non-finite or non-positive spring config instead of feeding it to the integrator — `mass: 0` produced NaN velocity and a spring that could never reach rest.
  - DevTools: `selectFinding` resolves plugin audit rows to their entities (the unified row list the tree already showed); the transient "owned by parent" warning is inserted at the top of the inspect readout instead of being dropped as row 21 of 20; the full-scene a11y audit is cached across refresh ticks and recomputed on `structureVersion` changes instead of re-walking the tree every 500 ms; the a11y audit, reading-order query, and `inspectA11y` survive a throwing app-supplied `getA11yAttributes()` per entity; and the accessible name / duplicate-label audit uses the full announced string rather than the 80-char display preview, so long labels sharing a prefix no longer collide as false duplicates.

## 0.11.0

### Minor Changes

- ca63f77: Rename the Markdown streaming reuse metrics to describe what they measure, and
  report the parser cost that was missing.

  `marked` has no incremental lexing API, so `MarkdownWorker` calls
  `marked.lexer()` on the **whole accumulated source** for every streamed chunk —
  its own comment says so — and `matchLen` is a raw-string comparison against the
  caller's prior token raws. The counters built on those two values were named as
  though a high match rate meant less lexing:

  | before          | after                   | what it actually counts                                                    |
  | --------------- | ----------------------- | -------------------------------------------------------------------------- |
  | `tokensReused`  | `tokensPrefixMatched`   | leading tokens whose `raw` was unchanged, so their entities were kept      |
  | `tokensRelexed` | `tokensReturned`        | tokens in the changed suffix the worker cloned back — the transfer payload |
  | `reuseRatio`    | `tokenPrefixReuseRatio` | `matched / (matched + returned)`                                           |

  A reader optimising against the old names would keep attacking the transfer path,
  which PRs #263 and #264 already reduced by 89×. The lexer, meanwhile, was
  invisible.

  So this also **adds** the figures that were missing, rather than only renaming:
  the worker now times its own `marked.lexer()` call and reports `lexerMs` and
  `sourceCharsLexed`, surfaced as a new "Parser cost" group in the `Markdown`
  devtools descriptor and a `lexer` row in `formatMarkdownStream`.
  `sourceCharsLexed` grows ~O(n²) across a stream of n chunks, which is the shape
  the old metrics obscured.

  `MarkdownStreamInfo` gains `lexerMs` and `sourceCharsLexed` alongside the three
  renamed fields. The old names are not kept as aliases: the defect is that they
  mislead, and keeping them would preserve exactly that. Anything reading them from
  `inspectMarkdownStream`, the descriptor labels, or the `low-token-reuse` finding's
  message needs the new names.

  Nine docstrings and audit messages across both packages claimed the changed tail
  was "re-lexed" — including `tailFraction`'s, which described it as "fraction of the
  document re-lexed" when that fraction is always 1.0. They now say "changed".

### Patch Changes

- 6b39a07: Nest composite widgets in the accessibility projection.

  The projection was flat: every mirror was appended to the projection root as a
  sibling and reading order came from sorting. That is valid for most of ARIA,
  which relates elements by IDREF, but a handful of composite widgets are specified
  in terms of ownership — a `gridcell` is only a grid cell because a `row` contains
  it. Flat, those widgets were structurally invalid however correct their
  attributes were, and axe's `aria-required-children` / `aria-required-parent` had
  to be disabled.

  The projection now nests exactly the role pairs ARIA requires to be
  DOM-contained, derived from axe-core's own role table:
  `grid`/`table`/`treegrid` → `row` → `gridcell`, `tablist` → `tab`,
  `tree` → `treeitem`, `menu` → `menuitem`, `listbox` → `option`,
  `list` → `listitem`. Both rules are now enabled and asserted in CI against
  real Chrome and Firefox.

  Deliberately narrow. `radiogroup`/`radio` is absent from ARIA's containment
  requirements, so `RadioGroup` stays flat, and a role a container may not own is
  never nested under it — axe checks unallowed children before it reviews empty
  containers, so nesting one would convert a passing tree into a violation.

  Rendered geometry is unchanged. A nested mirror's `left`/`top` resolve against
  its container rather than the projection root, so those values are now rebased
  through the inverse of the container's transform; every element's
  `getBoundingClientRect` is identical to the flat projection's, including under a
  rotated and scaled ancestor.

  `Scene` also sets `data-vecto-a11y-root` on the projection root, so an audit can
  scope to the projected layer instead of the whole document.

  `@vectojs/devtools`: `a11yInspect`'s `readingOrder` is now the node's position in
  document order across the whole projected layer. It was the node's index among
  its siblings, which under nesting restarts at 1 inside every row and stops being
  comparable between widgets.

- 7673748: `auditTree`: recognize virtualized `Table` body clips as scrollable.

  The default scroll-owner list now uses the exported `Table` name instead of the stale `Tree` name, and clipping children inherit a configured direct parent's vertical-scroll exemption.

## 0.10.0

### Minor Changes

- 13f9dcc: Report per-frame accelerator status, and stop rendering stale world matrices.

  `Scene.accelerators` returns `{ transform, animation, hitTest, particle }`, each
  `{ available, activeThisFrame, reason, path }`. The existing getters
  (`transformBackend`, `animBackend`, `hitTestBackend`, `particleBackend`) report
  only that a backend is INSTALLED, so a scene holding four WASM backends and
  running every frame in JS described itself as fully accelerated. `reason` is a
  named union — `'active' | 'not-installed' | 'below-gate' | 'rejected' |
'not-applicable'` — that separates a tuning outcome (`'below-gate'`, working as
  designed) from a fault (`'rejected'`, the kernel refused its own arguments).

  `@vectojs/devtools` gains `inspectAccelerators`, `auditAccelerators`,
  `formatAcceleratorInspection`, and the `acceleratorInspector`/`acceleratorAudit`
  plugins, from the headless entry as well as the panel. The audit fires only on
  `'rejected'`: warning about a gate that is working correctly would train readers
  to ignore it.

  Fixes a stale-render bug found while wiring this up. `Scene._syncWasmStore`
  discarded `runKernel`'s status and returned the world-matrix views regardless, so
  a rejected kernel — which writes nothing — left the previous frame's matrices in
  place and the render walk consumed them as current. The batch `compose()` path
  already guarded against exactly this; the resident per-frame path did not. It now
  returns `null`, routing that frame through JS composition. `uploadRuns` likewise
  returns a boolean rather than silently leaving the previous topology published,
  and `ComputeParticleEntity.stepWithBackend` returns whether the kernel ran so the
  Scene can report which path actually simulated the frame.

## 0.9.0

### Minor Changes

- dcb8a75: Add a page-backend / frontend bridge protocol.

  `createDevtoolsBackend(scene, transport)` serves 21 methods over a transport:
  tree, entity inspection and picking, highlight geometry, layout and a11y audits,
  snapshot and diff, hit explanation, text, Markdown streaming, GPU counters, plus
  plugin inspectors, audits and commands. `createDevtoolsClient(transport)` issues
  requests and correlates responses, with a timeout so a dead backend cannot hang a
  caller.

  Protocol only. The in-page panel is untouched and still calls the headless
  functions directly. Defining the protocol first and validating it against one real
  consumer is worth more than rebuilding the UI around an unvalidated protocol, and
  the same backend then serves an extension, Playwright and an agent without four
  implementations of the same queries drifting apart.

  **Origin enforcement has no permissive default.** A backend answers questions
  about the whole scene — text content, accessible names, geometry — so one that
  replies to any sender is an information-disclosure vector reachable by any frame
  that can post to the window. Requests carrying an origin are refused unless that
  origin is in `allowedOrigins`, and omitting the option refuses all of them.
  In-process callers carry no origin and are served, which is the panel and agent
  case. `createWindowTransport` forwards the sender's origin specifically so the
  check is possible.

  Results are round-tripped through JSON in the backend, so a handler that leaked a
  live entity reference fails in the backend's own tests rather than as a
  structured-clone error inside somebody's extension. `tree.get` is capped and
  reports `truncated` rather than silently returning part of a tree.

- dcb8a75: Add a GPU inspector with per-backend render counters.

  `IRenderer` gains a `kind` discriminator and optional `setDrawCounters` /
  `getDrawCounters` / `clearDrawCounters`. `kind` exists because `constructor.name`
  minifies away, and a debug tool that cannot name the backend in a production build
  is not much use. `CanvasRenderer` implements the counters: fills, strokes, text,
  images, circles, batch commits, save/restore, clips, and style switches that were
  not elided. Off by default, so the guard is one null test per op.

  `WebGLPointRenderer` exposes `stats()`: per-frame and cumulative draw calls, MSDF
  atlas switches, and the split between circles on the `gl.POINTS` fast path and
  those falling back to quads. Batching there is per primitive type, so draw calls
  and batches are the same number. `Scene` gains `webglDrawStats` and
  `webgpuActive`; both GPU backends were entirely private before, so no reading was
  possible at all.

  `inspectGpu(scene)` aggregates all three sources plus existing phase timings and
  frame telemetry, and `auditGpu` reports `batch-not-amortising`,
  `unbalanced-save-restore`, `high-overdraw` and `circle-quad-fallback`.

  Three capabilities are named as unavailable rather than approximated. GPU timestamp
  queries need a `requiredFeatures` device request, query sets, resolve and staging
  buffers, and out-of-band async readback that cannot share the synchronous phase
  shape. Exact overdraw needs pixel-coverage readback Canvas2D does not offer, so
  `overdrawRatio` is submitted-area over surface-area, labelled a proxy that
  overstates, and its audit finding is `info` rather than `warn` for that reason.
  Deep WebGL frame capture points at Spector.js rather than vendoring it.

  Inactive and idle are reported differently throughout: `null` means the backend is
  not running, zero means it ran and did nothing.

- b027513: Draw the selection highlight as geometry layers instead of one bounding box.

  The panel drew only the world AABB, so a rotated entity showed its bounding box
  rather than its true edges, and every other box it carries was invisible. Those
  boxes diverging from each other is the bug class the highlight exists to reveal.

  `highlightGeometry()` returns the layout quad, `getBounds()` render box, nearest
  clipping ancestor, projected content bounds and accessibility bounds, each as a
  true polygon in scene coordinates and each flagged when it drifts from the layout
  box. `setHighlightLayers()` chooses what the panel draws; the default stays the
  single AABB so an existing screenshot reads the same.

  `sampleHitRegion()` covers the one layer that has no retrievable geometry:
  `isPointInside` is a predicate, so the region is approximated by probing a grid
  and emitting one span per scanline. It is off by default because cost is
  quadratic in the entity's size, and it compares by area coverage rather than
  extent — a circle inscribed in its box has exactly the box's extent while
  accepting ~79% of its points, so an extent check reports the most common
  divergence as none.

- dcb8a75: Add a Markdown streaming inspector.

  The component's descriptor already carried appends, worker responses and token
  reuse. Three things the item asked for were missing and are now recorded: worker
  round-trip time (mean and worst), the stable-prefix and changed-tail lengths in
  **characters**, and reused vs rebuilt vs updated-in-place child entity counts.

  `inspectMarkdownStream(entity)` reads those and derives the two quantities worth
  watching. Characters matter because token counts do not answer the question: a
  stream can reuse 95% of its tokens while still re-reading 60% of its characters
  every chunk, and only the character ratio shows the O(document)-per-chunk shape.
  Coalescing is derived as appends minus responses, but reported as zero when the
  worker never answered — otherwise a main-thread parse claims every append was
  coalesced when none were.

  `auditMarkdownStreaming(scene)` reports five classes: `tail-not-a-delta`,
  `low-token-reuse`, `slow-worker-roundtrip`, `no-worker` and
  `entities-mostly-rebuilt`. The first two fire independently, since they fail
  independently.

  The inspector reads the descriptor rather than importing `@vectojs/markdown`,
  keeping the dependency pointing the right way and the module out of the headless
  bundle's forbidden-import set.

- b027513: Add a plugin protocol so other packages can contribute DevTools panels.

  `registerDevtoolsPlugin({ inspectors, audits, commands })` returns a deregister
  function. Each inspector becomes a tab, filled from the current selection on
  refresh; audits merge into the existing audit list with their kind namespaced by
  plugin id; commands are addressable as `<pluginId>/<commandId>` and runnable via
  `panel.runCommand()`.

  The point is dependency direction: `markdown`, `text`, `graph3d` and `three` can
  contribute panels without `@vectojs/devtools` importing any of them, where a
  hardcoded tab per package would invert the graph and put a debug tool in the way
  of every new component.

  Also fixes the tab bar, which divided its width by the tab count — six built-in
  tabs at a 320px dock already sat near 51px each, and plugins pushed that to 27px.
  Tabs now keep a preferred width and the bar scrolls horizontally once they
  overflow: measured with 8 plugins, 13 tabs hold at 48px across a 624px bar that
  scrolls 320px, and selecting the last tab scrolls it into view.

  Every call into plugin code is wrapped. A throwing `appliesTo` excludes just that
  inspector, a throwing `rows` renders the error in its own tab, and a throwing
  audit becomes an `audit-failed` finding, so one broken plugin cannot take the
  panel down with it.

- b027513: Pair snapshot siblings by a stable key instead of by child index.

  `captureSnapshot` now records a position-independent `key` per node, preferring
  the component's declared `devtoolsKey` and falling back to its accessible label.
  `diffSnapshots` pairs by that key when every key on a level is unique, and
  addresses keyed nodes as `root > Row{k:row-42}` so the path survives reordering.

  The gain is attribution, not diff size. Measured on a 200-row list with distinct
  row text, a head insertion produces 201 diffs either way — the rows really did
  move — but unkeyed, all 200 additionally claim their text was rewritten, because
  each row is compared against its neighbour, and the inserted row is reported at
  the tail index rather than the head.

  Drawn text is deliberately not a key candidate: keying on content would turn a
  text edit into a removal plus an addition and lose the from/to. Colliding keys on
  a level fall back to index pairing rather than pairing arbitrarily, and the path
  falls back with them so a node is never addressed ambiguously.

- dcb8a75: Add a text inspector, the first consumer of the plugin protocol.

  `inspectText(entity)` reports what VectoJS's own shaping knows and a DOM inspector
  cannot: the UAX #9 base direction, per-character bidi levels collapsed into level
  runs, the L2 reversal segments the algorithm actually performs, the visual order
  permutation, grapheme clusters, and per-glyph visual x, advance and level read
  from a prepared content grid or prepared text. `shapeProbe(text)` runs an
  arbitrary string through the real pipeline, so a bidi or cluster question can be
  settled without editing the app.

  `auditTextShaping(scene)` reports entities with glyphs absent from the atlas,
  naming the offending characters — those are the ones paying for a canvas
  `measureText` per glyph.

  Four of the nine capabilities originally asked for are reported as unavailable
  with a reason rather than approximated, since a debug tool that invents a
  plausible number is worse than one that admits ignorance. Glyph ids do not exist
  in this engine at all — the atlas is keyed by codepoint. No script itemizer
  exists, only a whole-string boolean. No API names the font actually used for a
  run, so per-glyph atlas misses are reported instead. Prepared text carries
  advances but not placed positions, and `LayoutResult` has no line index.

## 0.8.0

### Minor Changes

- 5b0fc75: Add an accessibility inspector and audits.

  `inspectA11y()` reports the accessible name and where it came from, tabIndex,
  disabled, focused, flat reading-order position, and DOM bounds alongside canvas
  bounds — the divergence unique to a zero-DOM UI, where the canvas can look correct
  while the projected tree is wrong.

  `auditA11y()` covers five failure classes already observed in this codebase:
  `no-accessible-name`, `role-tag-conflict`, `disabled-divergence`,
  `focusable-but-clipped`, `duplicate-label`. `a11yReadingOrder()` lists the
  projected nodes in traversal order.

  The panel gains an A11y tab showing the selected entity's readout followed by the
  scene-wide findings, with findings belonging to the selection marked.

- 5b0fc75: Add the `getDevtoolsDescriptor()` protocol: entities describe their own debug
  surface, so DevTools needs no table of component types.

  `Entity.getDevtoolsDescriptor()` returns `null` by default. `VirtualList`,
  `ScrollView`, `Slider`, `Input` and `Markdown` implement it, exposing state a
  generic inspector cannot reach — visible range and pool/measurement counts,
  spring position versus target, normalised thumb position, selection offsets, and
  streaming token reuse ratio.

  `inspectEntity()` carries the descriptor, and the panel's Inspect tab renders it
  below the generic properties (20 rows, up from 8). Read-only fields are marked so
  an edit that would be reverted is not invited.

- ddd32f9: Add `explainHitTest(scene, x, y)`.

  Picking returned the entity that received a pointer event but never why, and the
  two failure modes that cost the most time — an invisible overlay swallowing clicks,
  a control clipped out of its scroll container — look identical from outside.

  Returns the winning entity plus every candidate considered with a verdict:
  `accepted`, `invisible`, `clipped`, `pointer-transparent`, `outside-shape`, or
  `occluded`. Verdicts mirror `Scene.findHitRecursively`'s own rejection conditions.
  `formatHitExplanation()` renders the chain as indented lines.

### Patch Changes

- 5b0fc75: Drive the DevTools tree from the scene's structure version instead of a fixed
  interval.

  `Scene.structureVersion` is now public. It was already maintained for the resident
  WASM transform store (bumped by `Entity.add`/`remove`), and exposing it lets a
  consumer replace a tree walk with an integer comparison.

  The panel rebuilt both trees every 500ms regardless of whether anything changed, a
  constant CPU cost proportional to entity count. It now rebuilds only when the shape
  changed, with a forced reconcile every 3s as a consistency check. Selection details
  still refresh every tick, since properties change without the shape changing.

- ddd32f9: Show whether a property is a runtime override or computed by the parent's layout.

  `Entity.getLayoutControlledProperties(child)` lets a container declare which of a
  child's properties it recomputes. `Stack`, `Table`, `Tabs`, `RadioGroup`,
  `ResizablePanel` and `ScrollView` implement it; `ScrollView` answers per child,
  since it owns geometry on its internal wrapper but not on the children a caller
  adds inside it.

  DevTools marks those properties in the readout, names the owning container, and
  shows a warning after an edit that will be reverted. The edit still applies —
  nudging a `Stack` child to see what moves is legitimate; the useful behaviour is to
  let it happen and explain why it did not stick.

## 0.7.0

### Minor Changes

- 2589602: Add dirty-reason attribution, so you can find out what keeps an `onDemand` scene awake.

  `renderMode: 'onDemand'` exists so an idle scene costs nothing, but it silently
  degrades to always-on the moment something marks the scene dirty every frame — and
  `dirty === true` says only _that_ it happened, never _what_ did it. Diagnosing that
  meant bisecting `markDirty()` call sites by hand.

  `markDirty()` now takes an optional source:

  ```ts
  scene.markDirty({
    entity: this.id,
    reason: 'text-changed',
    property: 'spans',
  });
  ```

  Attribution is off by default and recording costs nothing until
  `scene.setDirtyTracking(true)`, because `markDirty` is called from dozens of sites,
  several per frame, so the common path stays a single field write. Read the
  aggregated counts from `scene.dirtyReasons`.

  The engine's own call sites already carry attribution, so an animation or a
  child add/remove is identifiable without instrumenting anything.

  `@vectojs/devtools` adds `diagnoseDirty(scene)` (also on the `headless` entry),
  which turns the counts into a verdict:

  ```
  Continuous redraw detected: answer — streaming-text marked the scene dirty
  120x over 120 frames (1.00/frame). onDemand cannot idle while this continues.
  ```

  It distinguishes a cause firing every frame from one that merely fired often, and
  says plainly when `renderMode` is `'always'` (which makes the whole question moot)
  or when tracking was never enabled — reporting "no causes" in that case would read
  as a false all-clear.

## 0.6.0

### Minor Changes

- 394b958: Add a selection-overlap audit: `auditSceneSelection(scene, opts)` / `auditEntitySelection(scene, entity, opts)` report where a selectable text entity's transparent DOM content projection (what the browser lets users drag-select and copy) drifts from the glyphs the canvas actually drew. It compares live `Range.getClientRects()` against the entity's own `ContentProjection` line geometry, mapped into local logical px so the check is DPR/zoom-independent — catching the justify (widened gaps), RTL/bidi (visual reorder), and fractional-scale rounding failure modes. Empty result = every selection box tracks its glyphs, so it doubles as a QA gate when driven on a real browser (see `scripts/selection-harness`).

### Patch Changes

- b2530ae: Broad-phase the layout audit's sibling-overlap check. `auditTree` compared every
  sized sibling against every other one — O(k²) intersection tests _and_ O(k²)
  `worldBox()` calls, since the inner loop recomputed the other box each time — so
  auditing a long list or a wide table was quadratic in exactly the thing you most
  want to audit. Boxes are now computed once and candidates filtered through a
  `SpatialHashGrid` (the same broad phase the engine already uses for hit testing;
  re-exported by `@vectojs/core`, so no new dependency).

  Findings are unchanged — same pairs, same tolerance, same `ignoreOverlap`
  handling — verified against an exhaustive all-pairs reference over dense grids,
  wildly-varying box sizes, and sparse long lists.

  Measured on one parent with N non-overlapping rows (median of 7,
  `forge/baselines/devtools-audit-overlap-broadphase.json`): 200 rows 5.35 → 0.82ms
  (6.5×), 1000 rows 75.8 → 1.7ms (44×), 4000 rows **1280.7 → 7.4ms (173×)**. This is
  a dev-only path, so it buys tooling responsiveness rather than app frame time.

## 0.5.0

### Minor Changes

- 90a9f00: Modernize the inspector panel and add five features. Visual: the dock now has rounded inner corners, a soft drop shadow, a translucent blurred-glass background, and `Card`-grouped sections; the three actions became compact ghost text-glyph icon buttons (`⌖`/`⟳`/`⚠`) with tooltips. Features: (1) the tree, entity readout, audit findings, event trace, and settings are split across `Tabs`; (2) a filter `Input` narrows the tree by type/id substring (view-only — the index still resolves every entity) with header count badges for total/interactive/findings; (3) a live perf HUD strip reads `Scene.frameStats` (fps, ms/frame, entity count, render mode, rendered/skipped frames); (4) the Inspect tab gains inline `x`/`y`/`opacity` editors and Copy-path / Copy-state-JSON actions; (5) a Settings tab toggles the selection highlight and switches the refresh interval and dock side (left/right). New `DevtoolsOptions`: `dockSide`, `showPerf`, `defaultTab`; default `width` is now `360`. The panel now reflows on `window.resize` (the panel scene uses `disableWindowResize`, so it previously kept its construction-time height and pushed the bottom perf strip below the fold on shorter viewports/zoom); inline editors and the perf strip use larger, higher-contrast text; and tab/label/button widths were sized to avoid truncation. The `pointer-events: none` dock contract, `attachDevtools`, and all existing public methods are unchanged.

## 0.4.3

### Patch Changes

- 3cf1c58: Fixed `attachDevtools`' docked panel intercepting pointer input over the host page's right edge. The dock is a fixed `320px`-wide, full-viewport-height element pinned to the right (`position: fixed; right: 0`), and both the dock container and its canvas now set `pointer-events: none` — matching how the main `Scene`'s own `a11yRoot` works (the root opts out, individual interactive shadow elements opt back in via `auto`). Previously the dock container defaulted to `pointer-events: auto` (the unset browser default), so any click landing in that 320px band silently missed whatever host content was underneath it, even when the dock had no interactive chrome at that exact pixel — this affected every app's own right-edge controls (tab close buttons, toolbar buttons, etc.) whenever `?debug`/`attachDevtools` was active, and had already corrupted a forge audit's own headless interaction test before being caught. The panel's own buttons and VMT tree remain independently clickable through their a11y shadow elements, which set their own `pointer-events: auto`.

## 0.4.2

### Patch Changes

- d013893: Finalize event-trace default-prevention state after projected VMT keyboard routing, including in Chromium, and cover the browser timing contract with an end-to-end test.

## 0.4.1

### Patch Changes

- e282f2f: Route browser pointer cancellation through projected entities and DOM portals, release projected pointer capture safely, and retain cancellation in DevTools event traces.

## 0.4.0

### Minor Changes

- fc96dfa: Make browser-native text selection a reusable VectoJS contract. Core now keeps dynamically
  materialized content projections in VMT order, removes them with their subtree, hides projections
  outside clipping ancestors, and exposes `Scene.getContentElement()` for tooling. UI adds
  configurable selection to Text, RichText, Markdown, CodeBlock, and Table cells; projects fenced
  code; preserves RichText wrap points; and gives Table an explicit, render-pure layout pass with
  wrapped, single-owner cell projections. UI's Core peer range is also aligned with its stable API
  contract (`>=1.0.0 <2.0.0`). DevTools event traces now report `source: "content"` for events
  originating on projected selectable text.

## 0.3.1

### Patch Changes

- 8bbb5a2: Add the `@vectojs/devtools/headless` entry for audits, event traces, snapshots, inspection, and picking without bundling the visual panel or `@vectojs/ui`.

## 0.3.0

### Minor Changes

- Add an opt-in, bounded event-routing trace for pointer, wheel, and keyboard
  events. The in-page panel can render recent trace entries, while
  `createEventTrace` provides the same JSON-safe records to tests and agents.

## 0.2.0

### Minor Changes

- 72d8b3d: Headless audit + capture layer for state-space debugging:

  - `auditScene(scene, opts?)` / `auditTree(root, sceneBounds, opts?)` — structured layout findings: `text-overflow` (text escaping its container), `clip-overflow` (content cut off by a clipping ancestor, scroll-axis exempt for ScrollView-likes), sibling `overlap`, and `viewport-overflow` (drawn off-canvas). Deterministically sorted, JSON-safe, with `tolerance`/`ignore`/`ignoreOverlap`/`includeOverlay` options.
  - `inspectEntity(entity)` — structured `EntityInfo` (world bounds/transform, flags, text preview, a11y projection), the machine-readable sibling of `describeEntity`; plus `entityPath(entity)` and `textPreviewOf(entity)`.
  - `captureSnapshot(scene)` / `diffSnapshots(a, b)` — deterministic JSON scene-state tree and a structural-path-keyed diff for golden-state assertions.
  - Panel: new **Audit** button lists findings in place of the tree; `panel.audit()` and `panel.selectFinding(i)` drive the same flow programmatically.

## 0.1.1

### Patch Changes

- Tighten the `@vectojs/core`/`@vectojs/ui` peer dependency ranges to `>=1.0.0 <2.0.0` now that both have reached 1.0.0. The previous unbounded `>=0.1.0`/`>=0.2.7` ranges would have silently accepted a future breaking `2.0.0` of either package with no peer-dependency warning, defeating the point of the semver commitment.

## 0.1.0

### Minor Changes

- d00abdd: New package @vectojs/devtools: the in-page Virtual Math Tree inspector — live tree view with type/geometry/animation badges, one-shot entity picking, world-transform readout, keyboard nudge editing, and a host-overlay selection highlight; the panel itself is rendered with VectoJS. Core gains read-only Scene.rootEntity/overlayRootEntity accessors for tooling.
