---
title: "01 — Canvas-Native Selection — Dual-World Parity"
description: "Why canvas has no selection, how VectoJS keeps the painted world and the DOM selection world in parity, and every hard invariant that guards it."
order: 21
date: 2026-08-29
---

# 01 — Canvas-Native Selection — Dual-World Parity

> A canvas is ink on a bitmap. The browser's selection machinery — `Range`, `Selection`, `getBoundingClientRect`, `copy`, `find-in-page`, IME — lives in the DOM. VectoJS keeps two worlds aligned every frame: the **visual world** (what the GPU draws) and the **DOM selection world** (what the browser can select). This document is the contract between them.

## 1. Why canvas has no selection

The DOM gives text three things for free:

1. **Hit geometry** — `Range.getClientRects()` returns the browser's own laid-out boxes for any substring.
2. **Clipboard source** — `textContent` + `Selection.toString()` + `copy` event give the browser a linear string to serialize.
3. **Editing surface** — `<input>` / `<textarea>` own the IME candidate window, `compositionstart/update/end`, and `selectionStart/End`.

`CanvasRenderingContext2D.fillText` writes pixels. The browser cannot name them, find them, or copy them. `find-in-page` (Ctrl+F), `#:~:text=` fragment links, translation extensions, reader mode, screen readers, and crawlers are all DOM-walking — canvas is invisible to every one of them. Any canvas UI that wants native selection must **project** a semantic DOM layer and keep it geometrically indistinguishable from the ink. Drift of even 0.5 px paints a highlight that visibly slides off its glyphs; drift of one character copies the wrong text; drift of one grapheme cluster breaks caret placement for CJK and emoji.

The failure is always geometric — and it compounds with calibration. Even a correct per-grapheme layout will drift if `getBoundingClientRect` is quantized (DPR), if `style.font` is a getter (Chrome 480×), or if the overlay's containing block races the compositor (`fixed` vs `absolute`). Geometry, measurement, and compositor alignment are one system, not three. Two layouts that derive from the same logical string but measure it differently (different `measureText` path, different line breaks, different bidi order, different tab stops) will diverge. The rule for all of VectoJS text: **compile once, consume twice** — one retained geometry plan feeds both paint and projection, never two independent layouts.

## 2. The two worlds

```text
┌──────────────────────────────────────────────────────────────────┐
│  Visual world — canvas                                           │
│  source: string ──► LayoutEngine / prepareContentGrid            │
│       │                    │                                     │
│       │  PreparedText / PreparedContentGrid (immutable, retained)│
│       ▼                    ▼                                     │
│  flushRun / per-glyph fillText / MSDF atlas ──► pixels           │
│  at world transform (a,b,c,d,e,f) × DPR × page zoom              │
└──────────────────────────────┬───────────────────────────────────┘
                               │  same source, same plan, same epoch
                               │  same font, same advances, same x/y
                               ▼
┌──────────────────────────────────────────────────────────────────┐
│  DOM selection world — a11y / content layer                      │
│  getContentProjection() ──► ContentProjection                     │
│       │  { text, font, lineHeight, baseline, lines[], grid }     │
│       ▼                                                          │
│  Scene.syncA11y ──► per-line carriers (<span>)                   │
│       │  data-vecto-grid-cell / per-grapheme spans               │
│       ▼                                                          │
│  live DOM Range ──► Selection / copy / find / IME anchor         │
└──────────────────────────────┬───────────────────────────────────┘
                               ↕
              calibrated each frame by CanvasGeometry
              + ContentProjectionManager grid calibration
              + DPR / page zoom compensation (256 px basis)
              + font-epoch / viewport-epoch generation stamping
```

Both worlds derive from **one logical source** (`source: string`) and one retained geometry plan. Re-segmenting the source for the DOM creates a second layout that inevitably disagrees: different word breaks under CJK, different bidi visual order, different tab column stops, different line-height distribution. The projection never re-lays out; it reuses the engine's own coordinates.

Prepared grids in `packages/text/src/PreparedContentGrid.ts` and prose in `packages/layout/src/LayoutEngine.ts` differ only in unit (grid cell vs CSS px) — both emit `x/advance/level` per cell/glyph so the same Bidi-aware placement serves both.

The overlay that hosts the carriers is itself a geometric artifact. `CanvasGeometry.syncOverlay` (`packages/core/src/tree/scene/CanvasGeometry.ts:1`) keeps the `a11yRoot`/`portalRoot` layers aligned with the canvas CSS box via `getBoundingClientRect`, including the `position: fixed` vs `absolute` containing-block distinction that decides whether scroll needs JS compensation at all (§4.3). The overlay's CSS `transform: scale(cssWidth/width, cssHeight/height)` maps logical Scene coordinates onto the CSS box; the content projection manager then maps logical line coordinates onto that.

## 3. How VectoJS bridges it

### 3.1 One retained plan, two consumers

**Prose docs** — `Markdown` (`packages/markdown/src/Markdown.ts`), `RichText` / `Text` (`packages/ui/src/RichText.ts`, `packages/ui/src/Text.ts`) lay out via `LayoutEngine` (`packages/layout/src/LayoutEngine.ts:1`). The engine emits `LayoutResult` with `nodes: PreparedGlyph[]`, each carrying `x / y / width / height / sourceIndex / sourceLength / isRTL / style / object`. `RichText.buildVisualLineGroups()` (`packages/ui/src/RichText.ts:668`) groups glyphs by baseline (`node.y + 0.8*height`), slices `sourceText` with `projectedSlice()` (`packages/ui/src/RichText.ts:506`) so inline-object `alt` substitutes for `U+FFFC` in DOM text while `sourceIndex` arithmetic stays intact, and emits `ContentProjection.lines[]` with `runs`, `perGraphemeCarriers`, `shapedPaint`, `lineHeight`, `baseline`, `font`. The coarse tier (`hint.textOnly`) returns `{ text, font, lineHeight }` without building lines — O(1) for off-viewport blocks. Canvas `render()` and `getContentProjection()` share the same `result` object; identity (`===`) is the invalidation signal (`packages/ui/src/RichText.ts:259`, `_lineGroupsCache`). `Markdown` does the same at document scale, composing `Stack` of `RichText` blocks with `contentSemanticBudgetLeft`-gated materialization (`packages/core/src/tree/Scene.ts:600`, `DEFAULT_CONTENT_SEMANTIC_BUDGET = 256`).

**Code-like grids** — terminals, editors, `CodeBlock` (`packages/markdown/src/markdown-code.ts`) compile via `prepareContentGrid()` (`packages/text/src/PreparedContentGrid.ts:prepareContentGrid`). Inputs are `font` (CSS shorthand), `cellWidth`, `lineHeight`, `baseline`, `tabSize`. Output is an immutable `PreparedContentGrid` (`kind: 'content-grid'`, `revision`, `lines: PreparedContentGridLine[]`) where each `PreparedContentGridCell` carries `sourceStart/End`, `sourceCaretOffsets` (legal grapheme boundaries), `glyph` (shaped), `x`, `advance`, `level` (bidi). Arabic shaping (`ArabicShaper.ts`) and bidi reorder (`BidiResolver.ts:reorderVisual`) run once; cells stay in logical source order with `x` encoding visual order. `Typography.cssLineBoxBaseline()` (`packages/text/src/Typography.ts:cssLineBoxBaseline`) derives the canvas-compatible baseline from `fontBoundingBoxAscent/Descent` via the shared attached context — same value both worlds use. The grid is returned as `ContentProjection.grid` and reused for both paint and projection; tabs, wide CJK/emoji (`isWideCluster`), `VS15/VS16` variation, ZWJ clusters, bidi levels, `CR/LF/CRLF` source ownership (`nextSourceStart`) share one plan.

**Why retained matters.** Re-segmenting the source for the DOM creates a second layout. Measured on `compare-pretext.ts`: naive `0.5em` fallback was off by up to 50% (Japanese) while VectoJS matched DOM ground truth at 0% line-count error when given real metrics. Two layouts will always disagree; one plan eliminates the question.

### 3.2 Per-grapheme carriers — the only correct granularity

`Scene.syncA11y` materializes one invisible carrier `<span>` per **grapheme** for selectable prose (`packages/core/src/tree/Scene.ts:760`ff, `perGraphemeCarriers` path). Each carrier's width is the **isolated** grapheme advance at the line's actual font; its `left` is the shaped prefix width at that index minus accumulated logical offset. Why per grapheme:

- Carriers coarser than one grapheme already fail because the intra-carrier error is **kerning**, not grid fitting. Mixed CJK+Latin at **two** graphemes per carrier was −0.582 px (`vectojs-docs/KNOWN_ISSUES.md:137`). Non-linear, per-cluster, no uniform correction can absorb it.
- Gecko grid-fits DOM layout advances to integer device pixels while canvas `measureText` keeps fractional ones: ~0.36% per character, accumulating linearly. `text-rendering: geometricPrecision` and disabling kerning/ligatures measured **identical** to `auto` — no CSS escape hatch (`packages/text/src/measureContext.ts:34`, `KNOWN_ISSUES.md:131`). One carrier per grapheme is the fix that ships; `Monospace` (uniform advances) is gated off entirely (0 drift, no carriers).
- Carriers are `position: relative` + `display: inline-block` with `left = run.x − runningLogicalX` in logical DOM order (`packages/ui/src/RichText.ts:584`, `Scene.ts` per-grapheme path). Never `absolute` — it blockifies inline boxes (`computed display: block`), and layout-aware plaintext serialization breaks at every block box: `innerText` yielded 16 newlines vs 2 correct, 0 spaces vs 14 correct for justified text (`KNOWN_ISSUES.md:190`). Flow-relative keeps copy, find-in-page, and screen readers reading a line as a line. RTL/bidi shares this path; visual `x` comes from `BidiResolver` levels, DOM order stays logical.

The exception is `ui/Text`'s fast path: one shaped `fillText` per line (ink includes kerning/ligatures) declares `ContentProjectionLine.shapedPaint = true` (`packages/ui/src/RichText.ts:shapedPaint`). Its carriers use **shaped** prefix differences deliberately — matching paint (§4.1). Justified lines never use per-grapheme carriers; they reuse layout's own `positionedRuns` geometry (`packages/ui/src/RichText.ts:626`).

Segmentation itself is via `Intl.Segmenter` with `granularity: 'grapheme'` (`packages/text/src/PreparedContentGrid.ts:graphemes`, `packages/core/src/tree/Scene.ts:graphemeBoundaries`). Fallback is a deterministic codepoint-level segmenter (`fallbackGraphemes`) covering combining marks, variation selectors (`VS15/VS16`), emoji modifiers, keycap, regional indicators, and ZWJ. Monospace needs no segmentation at all (cell = character; `PreparedContentGrid` still ZWJ-aware for emoji in cell grids).

### 3.3 Content grid projection — the retained path

Grid carriers are `data-vecto-grid-cell` spans carrying `data-vecto-grid-sourceStart/SourceLength/advance/x/level/caretOffsets/font/lineHeight` (`packages/core/src/tree/scene/ContentGridProjector.ts:291`). They are:

- **Windowed** — only lines near the viewport mount (`contentProjectionMargin`, hint `minY/maxY` in `packages/core/src/tree/Scene.ts:projectedLines`). Off-screen carriers are `display: none` and cannot intercept input.
- **Reused** (`carrier reuse`, `#244`) — a streamed append reuses untouched lines' calibrated `scaleX` transforms in place (`packages/core/src/tree/scene/ContentProjectionManager.ts:536`). Only the rebuilt tail's cells are pending calibration.
- **Font-mirrored** — `ContentGridProjector` mirrors the font onto `data-vecto-grid-font` so calibration reads it back as a plain string without touching `target.style.font`, which in Chrome re-serializes on every read (`ContentProjectionManager.ts:292`, §4.4).

Selection in the grid is snapshot as **source offsets** (`ContentProjectionManager.ts:snapshotGridSelection`, `gridSelectionEndpointOffset`), not linear DOM offsets. `gridSelectionEndpointOffset` walks from the live `Selection.anchorNode/focusNode` up to the carrier cell's `sourceStart` and adds the cell-local offset, clamped to `sourceLength` (the trailing hard break lives in the same text node but belongs to no cell). Source offsets are stable against line breaking, windowing, and per-cell `scaleX` calibration; linear offset 0 means "first line currently materialized" and moves when the window does. `gridCaretAtSourceOffset` resolves a stored offset back to `TextCaretPosition` by scanning `data-vecto-grid-cell` in logical order — first covering cell wins, boundary resolves to the earlier cell's end (same caret).

### 3.4 Projection manager — who owns what

`Scene` is 6.5k lines; the projection was decomposed per `forge/decisions/file-decomposition-2026-08.md`:

| Owner                                      | File                                                       | What it owns                                                                                                                                                                                                                                                         |
| ------------------------------------------ | ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Scene.syncA11y` + `syncContentProjection` | `packages/core/src/tree/Scene.ts`                          | The walk, dirty-checking `ContentSyncState`, the four per-sync fields (`_syncSerial`, `contentSemanticBudgetLeft`, `contentSemanticDeferred`, `contentSelectionPresentThisSync`), `enforceA11yDomOrder`                                                              |
| `ContentProjectionManager`                 | `packages/core/src/tree/scene/ContentProjectionManager.ts` | Selection preservation (`preserveSelectionAcrossRebuild`, `snapshotGridSelection`/`restoreGridSelection`), grid calibration (`scheduleGridCalibration`), blank-region drag anchor (`beginBlankRegionDrag`/`gridSelectionLine`), generation stamping, probe lifecycle |
| `CanvasGeometry`                           | `packages/core/src/tree/scene/CanvasGeometry.ts`           | `clientToScene`, `syncOverlay`, `effectiveDPR`, `sizeGpuCanvas`, `OverlayGeometry` memo                                                                                                                                                                              |
| `ContentGridProjector`                     | `packages/core/src/tree/scene/ContentGridProjector.ts`     | Carrier materialization, `prepareContentGrid` consumption, data-attribute mirroring                                                                                                                                                                                  |
| `A11yProjectionManager`                    | `packages/core/src/tree/scene/A11yProjectionManager.ts`    | Ordering (`enforceA11yDomOrder` delegation), `pruneA11ySubtree`, `removeA11yRecursively`, `getA11yTree`                                                                                                                                                              |
| `Entity` a11y hooks                        | `packages/core/src/tree/Entity.ts:ContentProjection*`      | `ContentProjection` / `ContentProjectionLine` / `ContentProjectionHint` types, `getContentProjection(hint?)` contract, `contentEpoch`                                                                                                                                |

The four per-sync fields move together (`DEC-0020`/`DEC-0022` forbid splitting them). `syncContentProjection` (624 lines) stays on `Scene` because `syncA11y` calls it at its own recursion point — extracting either alone needs a back-edge (`DEC-0019` rule 1). The projection manager was extraction 3, reduced in scope by `DEC-0022`; the walk itself moves only as a pair with `syncA11y`.

### 3.5 Sync timing — never show the user a half-built DOM

**Per frame: materialization then calibration.** Calibration is a cold two-frame batch (`ContentProjectionManager.ts:700`ff): frame N builds a far-off-screen probe (`left: -100000px`, `width: 100000px`, `contain: layout style paint`), frame N+1 reads `Range.getBoundingClientRect().width` and writes `scaleX` per cell (`element.style.transform = scaleX(...)`). Overlapped so steady-state streaming (append with no layout change) costs one `querySelectorAll` selector match. Two early exits avoid the probe entirely: `pendingCells.length === 0` (already calibrated, `vectoGridReady` published from a frame callback, never synchronously — carriers laid out earlier in the same task would otherwise hand out zero-width rects) and `measurements.length === 0` (every pending cell was zero-advance or empty, stamped immediately).

**Read cost: one layout per walk, not per element.** `selectionPresent()` (`ContentProjectionManager.ts:selectionPresent`) memoizes one `Selection.anchorNode` read into `presentThisSync` (one forced layout per sync walk). `releaseSelectionForRebuild` cheap-rejects when neither a tracked anchor nor a live selection exists — the bulk-materialization path (hundreds of blocks) pays no layout. `presentThisSync` is invalidated at the top of each walk and cleared after any release or `setBaseAndExtent`.

**Generation stamping.** Font epoch (bumped on webfont load, `createMeasuringContext` recreation) plus `pageScaleX` (browser zoom, basis 256 px) form the calibration generation (`ContentProjectionManager.ts:524`, `stamp = fontEpoch:pageScaleX.toFixed(4)`). A bump increments `calibrationGeneration`; every per-cell `scaleX` is implicitly invalid without touching carriers. Cells carry `data-vecto-grid-calib = generation` so reuse leaves untouched lines alone.

**The rebuild hazard.** Replacing projection children while a user has a selection in the unchanged prefix wipes it — a streaming message replaces its projection children on every appended chunk. `preserveSelectionAcrossRebuild` (`ContentProjectionManager.ts:preserveSelectionAcrossRebuild`) snapshots endpoints as linear character offsets (`projectionAbsoluteOffset`) for prose or source offsets for grids, skips when a blank-region drag is live (browser is authoritative mid-drag) or when the owning element does not contain the selection, then re-resolves against the new DOM after `rebuild()` and restores via `Selection.setBaseAndExtent`. The adjacent `refocus` snapshot in `A11yProjectionManager.ts:211` does the same for `document.activeElement`; selection had no equivalent until `KNOWN_ISSUES.md:232`'s streaming-collapse fix.

**Virtualization boundary.** `contentProjectionMargin` (finite) frees whole off-screen blocks; `Infinity` keeps them resident (at ~137 ms per `syncA11y` at 10k blocks). Browser find covers materialized content; a virtualized entity not mounted cannot be searched — an app must keep find targets resident.

**Why the budget is 256.** Sized against two measured costs: creating one `Span` per block (~0.4 ms) vs finishing the walk. At 64, total wall time was ~6× (`ContentGridPageScaleBasis.test.ts` era) with no frame-bound gain (`Scene.ts:595`). 256 is where the two goals stop trading.

**Deferred budget.** `contentSemanticBudgetLeft` (`Scene.ts:600`, default 256 blocks) caps one sync walk so a 10k-block doc finishes in ~285 passes, not one janked frame. `contentSemanticDeferred` holds the overflow; `contentViewportEpoch` ensures a resize re-tiers without moving blocks. Carriers for the deferred tail are coarse (`textOnly`) until their pass — selection geometry is deferred with them, which is correct because an off-screen block cannot own a drag.

### 3.6 Pointer → caret: how a click finds the right Text node

Clicks start in viewport (`clientX/Y`) and must land on a `TextCaretPosition { node: Text, offset: number }` in logical Scene coordinates (`Scene.ts:clientToScene` is only for hit-testing; projection has its own inverse).

- **Prose doc lines** (`Scene.ts:nearestOffsetForPoint`): given the `Text` node for a line, enumerate `graphemeBoundaries()` (same `Intl.Segmenter` as §3.2), place a collapsed `Range` at each boundary, call `range.getBoundingClientRect()` to get the browser's own glyph box, and pick the nearest by `distanceToRectSquared`. Caret lands on a legal grapheme edge, not inside a cluster. `distanceToRectSquared` is tested against viewport edges so a miss outside the line still resolves to the nearest endpoint.
- **Grid cells** (`Scene.ts:gridCellCaret`, `nearestGridPositionInLine`): cell data `level/advance/x/caretOffsets` give visual vs source fractions. `visuallyRtl = (level & 1) !== 0` flips `visualFraction → sourceFraction`, then `caretIndex = round(sourceFraction × (caretOffsets.length−1))`. The mapping is Bidi-aware: an RTL cell's rightmost visual point is its logical start. `nearestGridPositionInLine` prefilters cells by `localX ∈ [x, x+advance]` for exact hits, then nearest by horizontal distance.
- **Grid lines under affine transforms** (`Scene.ts:clientToGridLocal`): the fast path reads three `data-vecto-grid-basis="origin/x/y"` markers placed on line 0 (`ContentGridProjector.ts:basis markers`) and recovers the affine by inverting the 2×2 basis (`determinant = xx*yy − xy*yx`). The fallback inverts the content root's CSS `transform` (`parseCssMatrix`) and compensates `canvasRect → logical` scale for DPR/page zoom. The same determinant threshold (`1e-9`) gates both. When the line is unrotated/unscaled (`a>0, d>0, |b|,|c| ≤1e-9`), `Scene.ts:nearestGridPosition` skips the full inverse and maps `localX = (clientX − rect.left)/scaleX` for one extra cheap path.

All three share one vocabulary: `collectTextNodes` / `projectionAbsoluteOffset` / `projectionCaretAt` (`packages/core/src/tree/scene/content-caret.ts:1`). The latter's `affinity: 'forward' | 'backward'` pins a boundary offset to the leading or trailing text node — the difference between restoring a selection onto the end of cell N vs the start of cell N+1, which is the same caret.

### 3.7 Baseline contract: one number, two renderers

Canvas text and the content projection must use the same baseline offset inside a CSS line box, or every line after the first accumulates a vertical drift (measured ~0.35 em per line plus ~6 px on line 0 at 24 px, fixed in CTX-0333/0334).

`Typography.cssLineBoxBaseline()` (`packages/text/src/Typography.ts:cssLineBoxBaseline`) is the single source: `baseline = (lineHeight − ascent − descent)/2 + ascent`. Three tiers:

1. **Attached canvas** (`getSharedMeasuringContext().measureText('Mg').fontBoundingBoxAscent/Descent`) — same font as the painted canvas (§4.2 detached caution; `Typography.ts:32`). LRU 512 entries keyed `font\0lineHeight` (`BASELINE_CACHE_MAX = 512`), with LRU refresh on hit.
2. **Registered metrics** (`getFontMetrics(family).ascenderEm/descenderEm × size`, `Typography.ts:registeredBaseline`) — when no canvas exists yet or in SSR, same centering formula so a registered font and a real browser agree. Negative `descenderEm` flipped to positive to match canvas polarity.
3. **Fallback** — `lineHeight × 0.8` when family has no ascender/descender. Preserves the deterministic DOM-free contract; SSR and browser disagree only by the fallback, not by a missing layout.

Every workstream that centers font metrics in a line box must call this — `RichText.buildVisualLineGroups`, `TextEntity`, `MSDFTextEntity` (when glyphs map 1:1 to source), `ContentGridProjector`. Before this contract, `TextEntity`/`MSDFTextEntity` used ad-hoc `0.8em` and `(ascender−descender)em` pitches and missed the projection by ~6 px + 0.35 em/line in Firefox (fixed CTX-0333/0334).

### 3.8 Metrics chain: the order in which advances are resolved

Not every environment has a canvas. Three layers, consulted in preference order by `resolveGlyphMeasurer()` (`packages/layout/src/measure.ts:resolveGlyphMeasurer`):

| Priority | Source                                             | File                                                                                         | What it measures                                                                                                                                   | When it wins                                                                                             |
| -------- | -------------------------------------------------- | -------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| 1        | Canvas (`createCanvasMeasurer`)                    | `packages/layout/src/measure.ts:18`                                                          | Per-grapheme `ctx.measureText(char).width` at `baseSize=100`, derived linearly (`base × fontSize/100`), cache keyed `size+family+char+bold/italic` | Browser with a canvas — measures the font the renderer will actually draw, including synthesized weights |
| 2        | Registered MSDF/DOM-free (`createMetricsMeasurer`) | `packages/layout/src/measure.ts:108`, `packages/text/src/fontMetrics.ts:registerFontMetrics` | `advanceEm(char) × fontSize` or `measureEm(text)` for whole-string (covers kerning where per-glyph cannot)                                         | Node SSR, worker without `OffscreenCanvas`, test — one `registerFontMetrics(family, source)` at startup  |
| 3        | Fallback                                           | `packages/layout/src/LayoutEngine.ts:unmeasuredGlyphs`                                       | `0.5em` per glyph                                                                                                                                  | Last resort — `unmeasuredGlyphCount()` reports how many                                                  |

Chain rule: canvas wins deliberately (`measure.ts:resolveGlyphMeasurer` comment). Preferring registered metrics would let a stale registration override ground truth in the environment that has ground truth. Registered bold/italic are ignored (single advance table per family); `createCanvasMeasurer` resolves per-weight from real rendering and must be used when weight matters. `LayoutEngine` (`packages/layout/src/LayoutEngine.ts:92`) calls the measurer per `StyledSpan` run with `fontFamily/bold/italic`, so an inline `monospace` or bold run breaks at its own metrics. `fontMetricsVersion()` + per-measurer `baseVersion` cache avoids `normalizeFamily` allocation per glyph (+13% measured when that was done per glyph).

`EMPTY_GLYPH_ATLAS` (`packages/layout/src/LayoutEngine.ts:EMPTY_GLYPH_ATLAS`, `packages/ui/src/RichText.ts:371`) is a frozen identity — not a fresh `{}` — so the engine's paragraph memo (`prepareRich` + `prepare`) is not invalidated on every layout (measured 2.68×: 88 ms → 32.8 ms on 200 re-layouts of 12 paragraphs, 0 → 2388 hits).

### 3.9 Streaming & windowing: where selection meets the document scale

`Markdown` (`packages/markdown/src/Markdown.ts:681`) composes a `Stack` of `RichText` blocks. Two orthogonal windowing mechanisms interact with selection:

- **`virtualizeBlocks`** (`MarkdownOptions.virtualize`, `Markdown.ts:614`, `virtualOverscan` default 800) — top-level blocks near the viewport mount; off-screen height as `RowHeights` (Fenwick tree over `height+blockGap`). Incompatible with streaming (`createStream`/`appendMarkdown`): a document that virtualizes must be rendered whole. Caller drives `setVisibleRange` each scroll frame (a `ScrollView` does so automatically).
- **`tableViewportHeight`** (`MarkdownOptions.tableViewportHeight`, `Markdown.ts:652`) — per-table row virtualization (`Table` virtualizes its own rows into a fixed `viewportHeight`). Independent of block windowing; works mid-stream because `Table.appendRows` mounts lazily. Applies to every table, short ones included — a two-row table is also fixed to this height, by construction (Table takes `viewportHeight` as `readonly`).

`Markdown.streamStats` (`Markdown.ts:951`) — cheap always-on counters — distinguish **transfer** (`tokensPrefixMatched`/`tokensReturned`) from **parser cost** (`lexerMs`/`sourceCharsLexed`). The old naming conflated them, sending readers to optimize the already-solved delta path. The worker's `incrementalLex` skips lexing the stable prefix; degraded shapes (two `DegradeReason` cases) still pay O(document) per append — `sourceCharsLexed` tracking document length is the signal. `stablePrefixChars` is shipped by the worker's own `IncrementalLexCache.stableOffset`, not re-summed per response (which was O(n²) over a stream of n chunks, #657).

`CodeBlock` (`packages/markdown/src/markdown-code.ts`) and display math (`MathBlock`, `packages/markdown/src/markdown-math.ts`) are **not** registry fenced-block renderers (`Markdown.ts:138`). The registry receives `(source, lang, options)` but both paths need instance state — `subscribeInlineMathRepaint` and `subscribeInlineMathRaster` / `subscribeInlineImageRaster` for `onDemand` scenes, plus the one-object `RichText` that lets a formula reach selection/find/copy. Registry copies silently diverged (`MathBlock` constructed as `(mathRender, source, ...)` when signature is `(formula, svgUri)`), breaking 7 tests (`Markdown.ts:154`). The registry is an extension point for languages the package does not implement.

Copy relevance: a `Table` cell is projected per cell; a `CodeBlock` grid uses `PreparedContentGrid`; a `MathBlock` formula is projected text plus accessible name; each participates in find/selection only when materialized. The clipboard copy for a selection spanning multiple blocks is the concatenation of `projectedSlice` per block — inline SVG/Math alt substitution per §3.1 keeps offsets intact.

### 3.10 Baselines and why they exist

`forge/baselines/*` and `vectojs-docs/forge/baselines/*` pin the numbers this document cites so a future change can be bisected rather than re-measured from hearsay. Concretely: the 256 px basis table (1/2/4/10/100/1000 px → 0.9921875…1.0), the detached-vs-attached `measureText('MMMMMMMMMM')` triple for `monospace/serif/sans-serif` on Firefox (`measureContext.ts:1`), the 64.8 px scroll-vs-render misalignment (661 frames / 630 px smooth scroll), the 288/290 ms `style.font` getter cost (Chrome vs 0.6 ms Firefox), and the `Stack` + `RichText` block memo hit-rate (0 → 2388 after `EMPTY_GLYPH_ATLAS`). `KNOWN_ISSUES.md` records the per-grapheme rejection (two graphemes → −0.582 px on mixed CJK+Latin) and the `absolute`-carrier plaintext failure (16 newlines vs 2, 0 spaces vs 14). When a new engine or host reports a different gap, re-run the harness at the pinned `DPR/ZOOM` and compare against the baseline commit — the diff is whether the fix is a viewer bug or a VectoJS regression. `packages/core/test/ContentGridPageScaleBasis.test.ts` is the only unit-level oracle for the quantization; everything else needs a headed browser (COOP/COEP for `performance.now` fidelity, focused window for compositor callbacks — see `vectojs-performance` skill).

## 4. Hard parts — with receipts

### 4.1 Kerning drift: whole-string vs isolated advances

Layout positions glyphs by summing **isolated** per-grapheme `measureText(char).width` (`packages/layout/src/measure.ts:createCanvasMeasurer` → `getSharedMeasuringContext()`, `baseSize 100` scaled arithmetically). Paint stays within 0.5 px of layout (`packages/ui/src/RichText.ts:COALESCE_TOLERANCE_PX`) — `flushRun` coalesces a run into one `fillText` only when `abs(measureText(runText) − sum(isolated)) ≤ 0.5` (`RichText.ts:1001`), otherwise falls back to per-character draws at `node.x`. Whole-string `measureText(text).width` includes kerning the canvas never paints. Carriers that used whole-string widths were therefore **ahead of the ink by the accumulated kerning delta**, up to 5–8 px on a ~300 px kerning-heavy 16px Latin line, both Gecko and Blink (`KNOWN_ISSUES.md:168`).

Fix: carrier widths follow the line's paint model via `ContentProjectionLine.shapedPaint`. Per-glyph painters (`RichText`, core `TextEntity`) get isolated grapheme advances; `ui/Text`'s fast path (one shaped `fillText` per line) declares `shapedPaint` and keeps shaped prefix-difference carriers. Justified lines reuse layout's own `positionedRuns` geometry and never had this drift. `logicalRuns` sums isolated advances via `mctx.measureText(segment)` (`RichText.ts:598`); `positionedRuns` reuses `node.x/width` directly. The per-grapheme path in `Scene.ts` mirrors this branch.

A sibling fix: `RichText.logicalRuns` earlier used whole-string measurement per run; `Scene`'s per-grapheme path measured shaped prefix differences — same class, same fix (PR #460, `@vectojs/core@1.35.1` + `@vectojs/ui@2.16.3`).

### 4.2 DPR quantization and the 256 px page-scale basis

Browsers round `getBoundingClientRect().left` to **1/64 device px** (`ContentProjectionManager.ts:62`, `CanvasGeometry.ts:PAGE_SCALE_BASIS_PX`). A 1 px probe quantizes to a multiple of 1/64; at DPR 1.1 the recovered page scale was **0.9921875** (=63.5/64) where true was 1.0 — a 0.78% error (`ContentProjectionManager.ts:68`). Every per-cell `scaleX = advance * scale / natural` (`ContentProjectionManager.ts:717`) shrank by that factor: 18.0001 px pitch selected as 17.8624 px, leaving a **0.133 px** gap at every CJK seam and 0.061 px at every Latin one; at DPR 1.1 those land on a device-pixel boundary and paint as a vertical white line `使|用|sudo` (`ContentProjectionManager.ts:71`). Measured over bases 1/2/4/10/100/1000 px on the same page: `0.9921875, 1.0, 0.998046875, 1.0, 1.0, 1.0` — every basis ≥10 px agreed exactly; the 1 px read was the outlier.

Fix: measure over **256 px** (`PAGE_SCALE_BASIS_PX = 256`, `ContentProjectionManager.ts:85`). Worst case becomes `1/64 / 256 = 6.1e-5` (0.0011 px residue on 18 px, ~100× below a browser-representable pixel) while staying far inside the probe's 100000 px width so it cannot introduce a scrollbar or its own layout (`ContentProjectionManager.ts:80`). Test oracle: `packages/core/test/ContentGridPageScaleBasis.test.ts` models the quantization directly.

Sibling: detached measuring canvases resolve generic families wrong on Firefox (`packages/text/src/measureContext.ts:1`). `22px monospace` detached 109.737 vs attached 131.579 vs layout 132.000; `serif` detached collapsed onto `monospace`'s fallback (−47% on `serif`, −20% on `monospace`). Only `sans-serif` happened to agree, which is why Chromium-only testing hid it. Every measurer must use `getSharedMeasuringContext()` (attached, `document.body`-parented, never `display: none`). `OffscreenCanvas` measures correctly (132.000) but the contract is "measure where you paint" — the painted canvas is attached, so the measuring one must be too. The residual ~0.3% attached-vs-layout gap is the Gecko grid-fit of §4.4, not this.

### 4.3 Compositor vs main thread vs fixed/absolute drift

A `position: fixed` full-viewport canvas is composited against the viewport **off the main thread**; an `absolute` overlay is laid out against the scrolling document. Keeping them together by re-deriving `top` from `parent.getBoundingClientRect()` per **rendered** frame left the overlay stale whenever scroll advanced without a render. Measured on a live full-viewport scene, real key-driven smooth scroll over 630 px: 661 sampled frames, **1 frame misaligned by 64.8 px** (`CanvasGeometry.ts:191`).

Fix: overlay inherits the canvas's own `position` (`CanvasGeometry.ts:206`, `getComputedStyle(canvas).position`). `fixed` resolves `left/top` against the viewport — exactly `canvasRect.left/top` (`CanvasGeometry.ts:222`); `absolute` keeps parent-relative arithmetic with `clientLeft/scrollLeft` (`CanvasGeometry.ts:226`). Scroll then needs no JS compensation; the fix **removes** the per-frame dependency rather than syncing more often. A scroll listener would still race the compositor as main-thread work. Remaining writes are memo'd (`OverlayGeometry: left/top/cssWidth/cssHeight/width/height/position`, `CanvasGeometry.ts:235`) so an unchanged frame writes nothing — identical assignments still touch the CSSOM and grow with overlay layer count (`CanvasGeometry.ts:250`).

### 4.4 CJK sub-pixel gaps and font-lookup cost

After the scale fix, residual drift is the ~0.36% Gecko grid-fit (layout snaps to integer device px, canvas keeps fractional) — `text-rendering: geometricPrecision` is **not** a fix, measured identical to `auto` (`packages/text/src/measureContext.ts:34`, `KNOWN_ISSUES.md:131`). The same class of surprise produced a second, independent performance trap: `style.font` is a live shorthand getter that re-serializes from every font longhand on each read. The calibration scan that read `target.style.font` once per cell paid **288 ms of 290 ms (99.3%)** in Chrome while Firefox spent 0.6 ms on the identical loop — a 480× cross-engine gap whose only signal was the engine, not the work (`ContentProjectionManager.ts:292`). Fix: carriers store a plain `data-vecto-grid-font` string (`ContentGridProjector.ts:291`), and `ContentProjectionManager` reads that. `contain: layout style paint` on the probe isolates it.

### 4.5 IME, clipboard, and the editable mirror

`Input` / `TextArea` are **not** content projections. They project a real transparent `<input>` / `<textarea>` (`Site:Accessibility & Automation` §IME-aware input fields, `packages/core/src/tree/Scene.ts:a11y input mirror`, `packages/ui/src/Input.ts` / `TextArea.ts`). The browser owns the IME candidate window; the canvas mirrors `value/selectionStart/selectionEnd/composition` from the shadow node's `input`/`change`/`compositionstart/compositionupdate/compositionend` events and draws caret, selection highlight, and IME underline per frame. The shadow node is sized via `textInputStyle: { font, lineHeight, padding }` from `Entity.getA11yAttributes()` → `Scene` applies it with `box-sizing: border-box` while the canvas draws from the same padding and `Typography.cssLineBoxBaseline` — one baseline, two consumers, no vertical drift between the invisible editor and its ink mirror.

During focus, `Scene` avoids writing back the same user-synchronized `value` (echo suppression): if app state supplies a genuinely different value it is applied, but a controlled component that replaces text must preserve `selectionStart/End` intentionally or the caret jumps. `Input` is a single-line `a11yFullViewport`-aware entity; `TextArea` is a multi-line `clipChildren`-aware scroller with `scrollLeft`/`scrollTop` mirrored to canvas — the same world-transform → overlay path as any other entity, so DPR/zoom/rotation apply identically.

Clipboard path: `cut/copy/paste` and `undo/redo` are native, via that shadow node, for editable fields. For static selectable text, `copy` is the browser's own serialization of the projected layer: `projectedSlice()` (`packages/ui/src/RichText.ts:506`) substitutes each inline object's `alt` for the `U+FFFC` sentinel in **source** space so `LayoutNode.sourceIndex` arithmetic stays intact — an `alt` of any length other than one would otherwise shift every later offset and desynchronize selection boxes. The sibling `accessibleText()` (`RichText.ts:478`) exists for the `aria-label` path and is deliberately not used for slicing. `SeparatorAfter` (logical newline / preserved soft-wrap separator, `ContentProjectionLine.separatorAfter`) is merged into the line's final text node so Firefox cannot place part of a multiline selection at the projection root. `Table` cell copy, `CodeBlock` grid copy, and `MathBlock` formula copy all flow through the same per-block `projectedSlice` concatenation — inline SVG/Math `alt` substitution per §3.1 keeps offsets intact across block boundaries.

Cautionary tale: `packages/devtools/src/selectionAudit.ts:119` earlier captured `getSelection()` and then called `removeAllRanges` (`:157`) — an audit that destroyed user state. The current audit (`selectionAudit.ts:102`) uses detached `Range` (`document.createRange()` + `selectNodeContents` + `getClientRects`) which never touches `DocumentSelection`; there is no programmatic selection to clean up. Leave the user's selection exactly as found.

### 4.6 Grapheme, kerning, and the CJK white gap — the bug that looks like a rendering artifact

The `使|用|sudo` artifact reads like a GPU bug: a vertical white line between adjacent Han glyphs. It is a selection-projection bug seen through the raster. The chain is:

1. `getBoundingClientRect().left` quantized to 1/64 device px at 1 px basis → `basisScale` 0.78% low at DPR 1.1 (`ContentProjectionManager.ts:68`);
2. `scaleX = advance × basisScale / natural` 0.78% low (`:717`);
3. each `data-vecto-grid-cell` painted `advance` wide but selection box sized from `advance × scaleX` → every CJK seam 0.133 px short (`:71`);
4. at DPR 1.1 the shortfall lands exactly on a device-pixel boundary → the compositor leaves one column uncovered → white.

Latin seams are the same geometry (0.061 px) but narrower `advance` hides it. Changing the rasterizer, switching to `geometricPrecision`, or disabling kerning does nothing — the gap is not in the ink but in the `scaleX` the ink is drawn with. The test that guards it is the page-scale basis oracle (`ContentGridPageScaleBasis.test.ts`) plus the headed harness at `DPR=1.1`; headless DPR 1 reproduces nothing.

### 4.7 Calibration is not a one-time fix — font, DPR, and viewport each force a restamp

The per-cell `scaleX` is `advance × (pageScale × deviceScale) / natural` only at the instant it was measured. Any of three inputs can change without the entity moving: a webfont finishes (`contentFontEpoch` bump, `watchFontMetrics` → epoch, `Typography.clearCssLineBoxMetrics`), the user zooms (page scale via `getBoundingClientRect` 256 px basis, `ContentProjectionManager.ts:524`), or `devicePixelRatio` / canvas size changes (`Scene.resize` → `CanvasGeometry.effectiveDPR` → `contentViewportEpoch`). `calibrationGeneration` (`ContentProjectionManager.ts:calibrationGeneration`) conflates them into one counter so a single compare invalidates every cell. The failure when this is missed is silent: the old `scaleX` stays, the carriers are at the wrong width, and `selectionAudit` reports a drift that grows with line length but disappears on refresh. `data-vecto-grid-calib` is the field to watch — any `generation`-stamped cell that survives a zoom is a stale read.

### 4.8 How correctness is actually measured: the selection harness

Headless (`jsdom`, `--disable-gpu`) has no GPU, no compositor, no `Range` geometry at fractional DPR, and `performance.now()` coarsened to 100 µs without COOP/COEP — it cannot quote selection parity. Only `scripts/selection-harness/harness.ts` + `drive.sh` can. `harness.ts` builds a real `Scene` + `Markdown` + `CodeBlock` document with known source, font, `maxWidth`, then `drive.sh` launches a **real headed** Chrome and Firefox on a dedicated Hyprland workspace at `DPR` × `ZOOM` (`--force-device-scale-factor`, `layout.css.devPixelsPerPx`, `scripts/selection-harness/drive.sh:6`) and drives a native drag via the same `clientToGridLocal` / `nearestOffsetForPoint` path the user hits. `selectionAudit.ts:1` is the oracle: `expectedLeft/Right` from `ContentProjectionLine` geometry vs `actualLeft/Right` from the live DOM `Range` in **local logical px** (DPR/zoom divided out). Empty array = every selection box tracks its glyphs; any finding carries `entityId`, `entityPath`, `line`, `leftDrift/rightDrift` for bisection.

Three failure modes the harness is cut to catch: justified inter-word gaps, RTL/bidi visual reorder + `dir="ltr"` pinning, and fractional DPR/zoom rounding (`scripts/selection-harness/README.md:8`). Headless DPR 1 hides the 256 px quantization bugs and the ~0.36% Gecko grid-fit that ship at DPR 1.1/1.6 — run the harness at `DPR=1.5 ZOOM=0.9` as well as at 1× before claiming parity.

## 5. Invariants developers must keep

> Each invariant is a place where two code paths must agree on one number and one direction. If they disagree, the user sees a gap, a shifted highlight, or a lost selection — and headless passes hide it. The `file:line` is the place to check, not a suggestion.

1. **Measure where you paint.** Use `getSharedMeasuringContext()` (`packages/text/src/measureContext.ts`) — attached, `document.body`-parented, `opacity: 0` at `left: -9999px`, never `display: none`. Never a detached canvas for generic families; never re-measure `serif`/`monospace` without the document's style context. `fontMetrics.ts` (`packages/text/src/fontMetrics.ts:registerFontMetrics`, `registerMSDFFontMetrics`) is the DOM-free fallback (MSDFAtlas `advance`/`kerning`/`ascender/descender`), not the preferred path in a browser. After a webfont loads, call `clearCssLineBoxMetrics()` and let `watchFontMetrics` bump the epoch — stale cached advances are a line-width error before any projection is involved.
2. **One plan, two consumers.** Code-like entities: `prepareContentGrid()` once → same immutable object for paint and `getContentProjection().grid` (`packages/text/src/PreparedContentGrid.ts`). Prose: `LayoutEngine` once → same `LayoutResult` for `render()` and `getContentProjection()` (`packages/layout/src/LayoutEngine.ts`, `packages/ui/src/RichText.ts:284` cache). Never re-segment, re-wrap, or re-tokenize for the DOM. `EMPTY_GLYPH_ATLAS` as the atlas identity (`LayoutEngine.ts:EMPTY_GLYPH_ATLAS`) keeps the paragraph memo hot.
3. **Flow-relative carriers, in logical DOM order.** `position: relative` + `display: inline-block` with `left = run.x − runningLogicalX` (`packages/ui/src/RichText.ts:584`). Never `absolute` — it blockifies and breaks `innerText`/`textContent` plaintext, `find-in-page` line continuity, and screen-reader line iteration. RTL/bidi shares this path; visual `x` comes from levels, DOM order stays logical so `innerText` copies in source order. `contain: layout style paint` on the probe, not on carriers.
4. **Never kill carriers for a11y-tree size.** Per-character `StaticText` nodes read letter-by-letter (see `xuepoo-blog/src/text-utils.ts`); disabling carriers restores ~2 px drift in Firefox. The tree cost is real (see `Site:Accessibility & Automation` §Cost scales super-linearly: 6.4 µs → 136.9 µs/entity at 20k), but carriers are not the lever — windowing (`contentProjectionMargin`) and `a11yProjection: 'onDemand'` are.
5. **Source offsets are the only stable selection coordinates.** Linear DOM offsets drift when the grid window or line breaks change (`ContentProjectionManager.ts:gridSelectionEndpointOffset`). Snapshot grids as `sourceStart + withinCell`, prose via `projectionAbsoluteOffset`/`projectionCaretAt` (`packages/core/src/tree/scene/content-caret.ts`). Affinity `forward` vs `backward` decides which side of a cell boundary a caret pins to.
6. **Respect paint model.** `ContentProjectionLine.shapedPaint` tells `Scene` which advance to use; justified lines reuse layout's own glyph geometry (`positionedRuns`, `packages/ui/src/RichText.ts:626`). Setting `x` on a natural-flow run flips `hasPositionedRuns` and forces `dir="ltr"` — correct for justify/RTL, wrong for ragged LTR (`RichText.ts:533`). A ragged line must keep `dir="auto"` so the browser bidis the text itself and caret hit-mapping stays right.
7. **Inherit overlay position.** `CanvasGeometry.syncOverlay` (`packages/core/src/tree/scene/CanvasGeometry.ts:206`) must mirror `fixed`/`absolute` — don't re-derive `top` from the parent per frame. Memo `OverlayGeometry` and `invalidateOverlay()` only when a new layer (`glCanvas`/`gpuCanvas`/`portalRoot`) appears.
8. **Generation-stamp, don't sweep.** Font and zoom changes invalidate all `scaleX` via a generation counter (`ContentProjectionManager.ts:calibrationGeneration`, `calibrationStamp = fontEpoch:pageScaleX`); don't touch every carrier on epoch bump. Cells carry `data-vecto-grid-calib` so reuse leaves untouched lines alone.
9. **Preserve selection across rebuilds — but not mid-drag.** `preserveSelectionAcrossRebuild` / `snapshotGridSelection` + `restoreGridSelection` cover the streaming-rebuild hazard; blank-region drags are browser-authoritative and must not be interrupted. `releaseSelectionForRebuild` is the cheaper sibling when the selected text is no longer projected (window scrolled past it — leave the `Range` detached rather than pointing into detached carriers).
10. **One baseline, both worlds.** Every line box — canvas and DOM — calls `Typography.cssLineBoxBaseline()` (`packages/text/src/Typography.ts:cssLineBoxBaseline`). Never hard-code `0.8 * lineHeight` outside the fallback tier; that constant is the fallback, not the contract.
11. **Don't measure the measurer.** `style.font` is a live getter (`ContentProjectionManager.ts:292`); read `data-vecto-grid-font`. Likewise `getBoundingClientRect` forces layout — batch it (probe path) and memo it (`selectionPresent` / `OverlayGeometry`), don't read per element per frame.
12. **Virtualization is opt-in and exclusive.** `Markdown.virtualize` and streaming `createStream` do not compose (`Markdown.ts:614`); `tableViewportHeight` does (`:652`). Put find-critical blocks inside the mounted window or they are unfindable — materialization, not DOM tree depth, decides what Ctrl+F can see.

## 6. Debug checklist — when selection or copy drifts

### 6.1 Quantitative first

| Symptom                                                       | First probe                                                                                                                                                                                                                                                                                                                                                                   | What it tells you                                                                                                                                                                |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Highlight offset grows with line length                       | `auditEntitySelection` / `auditSceneSelection` (`packages/devtools/src/selectionAudit.ts:56`) — compares `expectedLeft/Right` (projection geometry) vs `actualLeft/Right` (`Range.getClientRects`) in **local logical px** (DPR/zoom removed via `rootRect.width / entity.width`). Default tolerance 2 px; right edge may need looser `rightTolerance` (kerning accumulates). | Whole-string vs isolated drift, or a `shapedPaint` mismatch.                                                                                                                     |
| Visible gap at every CJK seam                                 | Check `PAGE_SCALE_BASIS_PX` (=256, `ContentProjectionManager.ts:85`) and `data-vecto-grid-calib` generation; re-measure `probeOrigin/XRect → basisScale` (`ContentProjectionManager.ts:707`).                                                                                                                                                                                 | Page-scale quantization or stale calibration after zoom/DPR change.                                                                                                              |
| Selection collapses on reflow or streamed append              | `snapshotGridSelection` → `gridSelectionLine` (`ContentProjectionManager.ts:gridSelectionLine`) while extending a drag; verify `preserveSelectionAcrossRebuild` covers the owning element.                                                                                                                                                                                    | Linear vs source offset bug, or a rebuild that touches the anchored line. Check `blankRegionDrag` (`:blankRegionDragActive`).                                                    |
| Overlay highlight detaches on scroll                          | `CanvasGeometry.overlay` (`CanvasGeometry.ts:OverlayGeometry`) — `position` and `left/top` vs `canvas.getBoundingClientRect()` under a 630 px scroll.                                                                                                                                                                                                                         | `fixed` canvas with `absolute` overlay, or a missed `invalidateOverlay` after adding `glCanvas`/`gpuCanvas`.                                                                     |
| Grid ready-but-zero-width rect                                | `scene.getContentElement(id).dataset.vectoGridReady` timing — must publish from a frame callback (`ContentProjectionManager.ts:566`), never synchronously.                                                                                                                                                                                                                    | Carriers not yet laid out when a drag/measure ran.                                                                                                                               |
| Font swap leaves carriers stale                               | `contentFontEpoch` / `contentViewportEpoch` vs `calibrationStamp` (`ContentProjectionManager.ts:calibrationStamp`).                                                                                                                                                                                                                                                           | Missing epoch bump on font load or resize — check `watchFontMetrics` (`RichText.ts:290`) and `Scene.resize`.                                                                     |
| `Selection.toString()` looks correct but `innerText` is wrong | Compare `innerText` vs `textContent` vs `Selection.toString()` on the content root.                                                                                                                                                                                                                                                                                           | `Selection.toString()` walks text nodes and ignores layout — it cannot see `absolute`-blockified copy failure. Use `innerText` or a real clipboard read (`KNOWN_ISSUES.md:204`). |
| Selection survives at rest, breaks under scroll               | `CanvasGeometry.overlay.position` vs `getComputedStyle(canvas).position` (`CanvasGeometry.ts:206`), then `OverlayGeometry.left/top` under a live smooth scroll.                              | `fixed` canvas whose overlay stayed `absolute` — CSS containing block, not math, is the fix. |
| Drift only on Firefox, or only on generic families            | `isSharedMeasuringContextAttached()` (`packages/text/src/measureContext.ts:isSharedMeasuringContextAttached`) and `familyOf` (`packages/ui/src/measure.ts:familyOf`).                                                                                                                                                                                                         | Detached measurer on a generic family (`monospace`/`serif`) — Chromium hides it.                                                                                                 |
| `unmeasuredGlyphCount() > 0` and wrap is wrong                    | `LayoutEngine.unmeasuredGlyphCount()` (`packages/layout/src/LayoutEngine.ts:31`) — non-zero means some glyphs sized by `0.5em`; check `registerFontMetrics` / `hasFontMetrics()` (`packages/text/src/fontMetrics.ts:registerFontMetrics`).                                                                   | DOM-free environment with no font metrics registered — line widths and breaks are fabricated.                                                |
| Monospace still drifts                                             | `familyOf(this.font)` vs line's `font` (`packages/ui/src/RichText.ts:nodeFont`), and whether `perGraphemeCarriers` was gated off for the family.                                                                                                                                                                          | Mixed-family line where the `line.font` fallback (`monospace`) does not match the cell font — the grid path already carries per-cell font, the prose path must match it. |

### 6.2 Interactive probes

```ts
// Semantic snapshot — what the DOM actually projects (needs one frame after start())
console.log(JSON.stringify(scene.getA11yTree(), null, 2));

// Live node for one entity — dataset, rect, and whether it owns the selection
const el = scene.getContentElement(entity.id);
console.log(el?.dataset, el?.getBoundingClientRect());
console.log(scene.getA11yElement(entity.id));

// Quantitative drift, local logical px, needs a real browser (layout + Range)
import { auditSceneSelection } from "@vectojs/devtools";
console.table(
  auditSceneSelection(scene, { tolerance: 0.5, rightTolerance: 1 }),
);
// Single entity, or restrict to ids:
// auditEntitySelection(scene, entity, { tolerance: 0.5 })
// auditSceneSelection(scene, { entityIds: ["my-markdown"] })

// Calibration state on the live node
console.log({
  ready: el?.dataset.vectoGridReady,
  calibration: el?.dataset.vectoGridCalibration,
  pending: el?.dataset.vectoGridCalibrationPending,
  samples: el?.dataset.vectoGridCalibrationSamples,
  calibMs: el?.dataset.vectoGridCalibrationMs,
  fontEpoch: (scene as any).contentFontEpoch,
});

// Geometry readout — local logical x/y vs world transform
import { getContentGeometry } from "@vectojs/devtools";
console.log(getContentGeometry(entity));
```

Pass `debugA11y: true` in `SceneOptions` (`packages/core/src/tree/Scene.ts:SceneOptions`) to outline shadow nodes with a blue dashed border during development. Drive cross-engine, multi-DPR verification with `scripts/selection-harness/drive.sh` (`DPR=1.5 ZOOM=0.9`, `scripts/selection-harness/README.md`) — headless DPR 1 hides both the quantization bugs and the grid-fit drift that ship at DPR 1.1/1.6. That harness exercises justified lines, RTL/bidi, and fractional DPR/zoom, all three failure modes `selectionAudit.ts` was written to catch (`selectionAudit.ts:1`).

### 6.3 What the probes cost — don't turn a check into a regression

- `auditSceneSelection` itself calls `getBoundingClientRect` per line (layout-forcing) and must run on a real browser, not in a hot loop. Do not ship it on the frame path — gate it on a QA toggle or a Playwright harness.
- `scene.getA11yTree()` walks the a11y subtree; it is ordered by `A11yProjectionManager.enforceA11yDomOrder` and stable for assertions but not free over thousands of interactive entities (see §5.4 cost table: 715 ms @ 20k on Chrome). Snapshot once per verification, not per frame.
- `selectionPresent()` (`ContentProjectionManager.ts:selectionPresent`) is the production example of batching the same read: one forced layout per sync walk, not per element. Copy that pattern for any new projection health check.

> **A note on headings.** This document is one of three in the boss-01 triptych. Keep its H2 count and `order` stable so `vectojs-docs/content/learn/` index and `reference/core-a11y.md` anchors don't drift — check `scripts/sync-content.py` after any rename.

## 7. The full frame — six steps, in order

For a frame that extends a streaming code block by one line while the user has a selection in the unchanged prefix at DPR 1.6:

1. **Layout** — `prepareContentGrid` or `LayoutEngine.layoutPrepared` emits the new plan; `Stack` remeasures only the dirty block (`updateTokens` / `virtualHeights` Fenwick).
2. **Canvas draw** — `Scene.render` walks the VMT, applies `worldTransform × DPR`, issues `fillText`/`drawImage` batches. `flushRun` decision (`COALESCE_TOLERANCE_PX`) already baked.
3. **Overlay sync** — `CanvasGeometry.syncOverlay` aligns `a11yRoot` to `canvasRect`, inheriting `fixed`/`absolute` (`CanvasGeometry.ts:206`), memo'd (`OverlayGeometry`).
4. **Materialization** — `syncA11y` / `syncContentProjection` dirty-check `ContentSyncState` (world matrix, `hasBand`/`visible`, `fontEpoch`/`viewportEpoch`, `tier`), window carriers to `hint.minY/maxY`, reuse untouched grid lines' `scaleX`, create per-grapheme spans or `data-vecto-grid-cell` spans with `sourceStart/Length/x/advance/level/caretOffsets`.
5. **Selection preservation** — `ContentProjectionManager.snapshotGridSelection` as source offsets, `preserveSelectionAcrossRebuild` / `restoreGridSelection` after `rebuild()`, or `releaseSelectionForRebuild` if the selected text scrolled out. Blank-region drag stays browser-driven.
6. **Calibration (cold)** — frame N builds the 100000 px probe off-screen; frame N+1 reads `Range` natural widths, computes `scaleX = advance × basisScale / natural` with `basisScale` from the 256 px page-scale basis (`ContentProjectionManager.ts:707`), writes `transform`, stamps `data-vecto-grid-calib`. Steady state is one selector match; `vectoGridReady` published from a frame callback.

Any step that remeasures without going through step 1 creates a second layout and a future drift. Any step that reads `style.font` or `getBoundingClientRect` without going through the memo/attribute path pays the 480× / layout-per-element cost of §4.

---

**Further reading.** `vectojs-docs/content/learn/accessibility.md` (projection model, IME, find-in-page, cost table) and `reference/core-a11y.md` (composite widgets, roving tabindex, `pointerEvents: 'none'` hotspot pattern) set the tone this document follows: measured, per-engine, with the rejected alternative named, the number, and the `file:line` where it lands. `forge/decisions/file-decomposition-2026-08.md` §2 explains why the four per-sync fields and the two walks move only as a pair. `KNOWN_ISSUES.md` §Selection highlights / Positioned-run carriers / Core TextEntity projections record the fixed drifts and their traps. Never "should generally" — either the carrier is at `node.x` or it is not.

## Appendix — one drag, every file it touches

User presses in blank padding of a `Markdown` code block, drags across three lines, releases. DPR 1.6, `position: fixed` full-viewport scene, Firefox 153:

| Moment | What happens | Files |
| -------- | -------------- | ------- |
| `mousedown` in blank | `ContentProjectionManager.beginBlankRegionDrag` tracks `TextCaretPosition`; browser collapses `Selection` | `ContentProjectionManager.ts:beginBlankRegionDrag` |
| `mousemove` | `Scene.ts:nearestGridPosition` → `gridCellCaret` (Bidi-aware fraction) + `blankRegionDragActive` extends `Selection` via `setBaseAndExtent` | `Scene.ts:nearestGridPosition`, `ContentProjectionManager.ts:blankRegionDragActive` |
| Next frame: block reflows | `syncContentProjection` re-windows carriers; `snapshotGridSelection` saves source offsets | `ContentProjectionManager.ts:snapshotGridSelection` |
| Rebuild | `preserveSelectionAcrossRebuild` skipped (drag live → browser authoritative); `clearGridState` releases only non-owning blocks | `ContentProjectionManager.ts:clearGridState` |
| `mouseup` | `ContentProjectionManager.endDrag` clears `blankRegionDrag` + anchor; `getContentElement` rect is live | `ContentProjectionManager.ts:endDrag` |
| Two frames later | probe reads `Range.getBoundingClientRect().width`, writes `scaleX` for dragged cells; `vectoGridReady` published from frame callback | `ContentProjectionManager.ts:scheduleGridCalibration` |
| Copy (Ctrl+C) | browser serializes `projectedSlice` text (alt-substituted, separator-merged) from the now-calibrated carriers | `RichText.ts:projectedSlice` |

If any row is skipped or reordered, the invariant in §5 with the same row number is the one to re-read.
