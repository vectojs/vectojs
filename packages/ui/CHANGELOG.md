# @vectojs/ui

## 2.12.0

### Minor Changes

- ceb7e3f: Virtualize content projection per line inside one tall entity.

  `contentProjectionMargin` gates whole entities, which frees blocks that scroll
  away but cannot help an entity _taller_ than the viewport: its box always
  intersects, so every one of its visual lines was materialized — a `<span>` per
  line, and on the grid path a `<span>` per glyph cluster. That is the origin of the
  "14.8k elements for a 346KB Markdown document" already documented in `Scene`, and
  it made per-frame projection cost scale with the document instead of the viewport.

  `Scene` now materializes only the contiguous run of lines near the viewport, and
  passes that band to `Entity.getContentProjection(hint?)` so an entity whose
  projection build is O(glyphs) can make it O(visible glyphs). `Text`, `RichText`
  and `CodeBlock` honour the hint.

  Measured on one entity scrolled to its middle, real headed browsers, 4000 lines:

  |              | before        | after           |
  | ------------ | ------------- | --------------- |
  | Chrome       | 4.21 ms/frame | 0.20 ms (21.1x) |
  | Firefox      | 4.83 ms/frame | 0.14 ms (34.5x) |
  | DOM children | 36,000        | 1,026 (35x)     |

  The gated cost is flat across a 20x document-size range, so this converts an
  asymptote rather than shaving a constant.

  `ContentProjectionHint` is additive and advisory: ignoring it stays correct
  because the Scene windows the DOM regardless, so existing `getContentProjection`
  overrides keep working unchanged. The window is deliberately contiguous — a gap
  would let a drag across it silently omit the lines in between — and never empty,
  because text missing from the projection is invisible to find-in-page, copy and,
  for static text, the screen reader.

## 2.11.0

### Minor Changes

- 189f4e4: Add `Markdown.setMaxWidth()`, so a width change rewraps in place instead of
  requiring a full document rebuild.

  `Text` and `RichText` both had a `setMaxWidth`; `Markdown`, which composes them,
  did not — and assigning `maxWidth` alone changed nothing visible, because the width
  is read when each block is **built**. Measured before: `md.maxWidth = 300` left the
  paragraph 465 wide and the document box 712.

  The only correct workaround was a rebuild, and a real consumer had written one.
  `vectojs-gallery`'s chat Creation released its stream, replayed every revealed
  character through `setContent`, constructed a **new** stream writer because the old
  one was bound to blocks `setContent` had just discarded, and carried its scroll
  offset across by hand — on every resize frame that changed the width. That is now
  unnecessary.

  `setMaxWidth` walks the retained token list beside the existing child entities and
  hands each block its new width, recursing into blockquotes and list/image stacks.
  Nothing is re-lexed, no entity is destroyed or created, and an open `createStream`
  writer stays valid because the block structure it is bound to is untouched.
  `RichText`'s paragraph memo is keyed on content rather than width, so a re-wrap
  reuses the shaping and pays only for line breaking.

  Also adds two supporting primitives:

  - **`Table.setWidth()`** — assigning `width` alone was not enough, because
    `colWidths` is resolved once in the constructor and every cell's wrap width,
    position and alignment derives from _those_ per-column figures. A `Table` whose
    `width` was reassigned painted its chrome at the new size while its cells stayed
    laid out for the old one. Columns rescale proportionally, so a caller-supplied
    ratio survives a resize rather than being re-split equally.
  - **`CodeBlock.setWidth()`** — deliberately does not rebuild the grid or the
    highlight, because code does not reflow: lines sit on a fixed monospace grid and a
    long line overflows rather than wrapping, so height is a function of line _count_
    alone.

  Verified by a new both-engines gate, `packages/markdown/e2e/set-max-width.e2e.ts`,
  wired into `test:e2e`. Geometry alone is not the assertion there, because a rebuild
  produces correct geometry too — which is exactly how a consumer ended up writing
  one. It asserts the properties that distinguish a reflow from a rebuild: the same
  entity **instances** survive (identity tokens, not counts), an open stream writer
  stays `open` and keeps appending afterwards, and the lexer consumes **zero**
  additional source characters. Measured: 520px/2 lines/h=88 → 260px/4 lines/h=160,
  widest projected line 257.4 against the 260 wrap width, same 2 instances, stream
  open, 0 extra characters lexed, identical on both engines. Confirmed to fail against
  the pre-fix behaviour: 505.7px lines inside a 260px box.

### Patch Changes

- 5929e65: Project an inline object's `alt` into the content projection instead of the raw
  U+FFFC sentinel, so copying text containing inline math yields the formula.

  `RichText.getContentProjection()` built its text from `sourceText()`, which carries
  one literal U+FFFC per inline object because that is the string
  `LayoutNode.sourceIndex` indexes. The sentinel therefore reached the DOM mirror
  verbatim: a real browser `Range` copy of a paragraph with inline math yielded
  `'Iota \ufffc kappa.'` — an invisible character on the clipboard — while
  `getA11yAttributes()` was already returning the correct `'Iota E = mc^2 kappa.'`.
  Screen readers were fine; anyone selecting the text was not.

  This could not be fixed by swapping `sourceText()` for the existing
  `accessibleText()` at the top of `getContentProjection()`. Layout offsets index
  `sourceText()`, where an object is exactly one character, so an `alt` of any other
  length shifts every later offset and the per-line slices would desynchronise from
  the laid-out glyphs — the selection boxes would drift off the drawn text.

  Instead, a new `projectedSlice(start, end)` takes an interval in **source**
  coordinates and substitutes each object's `alt` only on the way out. Every offset
  stays in the coordinate space layout uses; only the emitted strings change. All four
  emission points now route through it — the projection `text`, each line's `text`,
  each line's `separatorAfter`, and the per-run text in both the natural-flow
  (`logicalRuns`) and justified (`positionedRuns`) paths. Substituting in only some of
  them would leave `projection.text` disagreeing with what the DOM assembles, which
  `Scene`'s dev-mode projection-mismatch check warns about and which
  `preserveContentSelectionAcrossRebuild` relies on when it snapshots caret offsets.

  An object with no `alt` contributes nothing, matching `accessibleText()`: an
  unlabelled decorative object is better absent from a copy than present as an
  invisible character. A paragraph whose only content is such an object still returns
  a projection rather than `null`, because emptiness is decided on the source — it
  occupies layout, and returning `null` would make `Scene` release and recreate the
  DOM node.

  Verified in both engines by a real `Range` copy, added as a fourth gate to
  `packages/markdown/e2e/selection-fidelity.e2e.ts` (its fixture document gains an
  inline-math paragraph). The gate asserts the copied text, that select-all carries the
  alt too, and that the copy and the accessible name now **agree** — a projection that
  regressed one but not the other is the exact shape of the original defect. Confirmed
  to fail pre-fix, with the DOM mirror reading `Iota \ufffc kappa.`. 13 new jsdom unit
  tests cover the multi-character, newline-bearing, absent, leading, trailing, and
  two-object cases.

## 2.10.0

### Minor Changes

- ae6d6ad: Paint strikethrough in `RichText`, and add per-column alignment to `Table`.

  `RichText` renders `@vectojs/layout`'s new `TextStyle.lineThrough` as one line
  stroked across each struck run. Unlike the link underline — which needs a segment
  per glyph — a struck run is already coalesced, so one segment spans it; struck-ness
  joins the coalescing key so a run is never part struck, and the line scales with
  the run's font size rather than being a hairline on a heading. A struck link gets
  both lines, which is reachable: `~~[x](url)~~` lexes to a `del` wrapping a `link`.

  `TableOptions.align` (new exported type `ColumnAlign`) takes one entry per column
  and accepts `'left' | 'center' | 'right' | null`, where `null` and a malformed or
  short array mean the previous all-left behavior. Alignment is applied by
  positioning each cell entity inside its column rather than by a text-align
  property, because the text components accept only `'left' | 'justify'`. All three
  positioning sites honor it — header, plain body, and virtualized body — so a
  virtualized table cannot align differently from a plain one past the scroll
  threshold. For a cell that wrapped to several lines this aligns the block, not each
  line within it.

### Patch Changes

- 773bbe6: Fix `TextArea` not scrolling with the wheel, and clicks landing on the wrong line.

  `TextArea`'s scroll offset was caret-driven only: it followed `selectionStart` and
  was never driven by the view. A wheel gesture landed on the shadow `<textarea>`
  (the topmost node under the pointer) and scrolled it, but the canvas kept drawing
  the same lines — measured in both engines, the mirror went to `scrollTop` 480 while
  the canvas stayed put. The same split broke clicking: the browser resolves a click
  against the mirror's view, so the caret landed on a different line than the one
  under the pointer — 29 wrapped lines off at load, because the caret is seeded to
  the end of the value and the canvas scrolled to the bottom while the freshly
  projected mirror was still at 0.

  `TextArea` now follows the offset its mirror reports (`@vectojs/core`'s new
  `'scroll'` event), which fixes both: the wheel scrolls because the browser already
  scrolled the real element, and clicks land correctly because both surfaces resolve
  against the same view. Caret-following remains as a fallback for when there is no
  mirror, such as a headless render.

## 2.9.0

### Minor Changes

- f55a409: Let `ScrollView` content be selected, and make its scroll physics configurable.

  `ScrollView` never overrode `getA11yAttributes()`, so it inherited `Entity`'s
  empty object. Being `interactive` (it needs wheel and pointer events) it still
  got a viewport-sized semantic mirror from `Scene`, and with no `pointerEvents`
  declared that mirror defaulted to `'auto'` and was ordered by `renderOrder`,
  while content projections are pinned to `zIndex: 0`. The transparent div
  therefore sat above the very text it wraps: a drag-select inside any
  `ScrollView` returned `""`. It now declares `pointerEvents: 'none'`, which is
  what the attribute was added for — structural containers whose descendants own
  the pointer surface. Wheel scrolling is unaffected, because `Scene` binds its
  wheel listener to the _content_ projection and dispatches to the owning node
  rather than to this mirror. Pointer-_drag_ scrolling directly over selectable
  text is the deliberate trade: a drag over text means "select this" everywhere
  else.

  Scrolling also always used the default spring (`stiffness: 180`,
  `damping: 12`), which is underdamped — ζ ≈ 0.447 against a critical 26.83. One
  240px wheel tick was measured overshooting 47.45px (19.8%) with 5 direction
  reversals, settling to ±0.5px only at 801ms and reporting pending animations for
  every one of 181 sampled frames, so a single tick cost roughly 0.8s of
  full-rate rendering plus a long tail. That reads as liveliness on a short list
  and as a bounce on a document, and there was no public knob. `ScrollViewOptions`
  now takes `scrollPhysics?: MotionConfig`, defaulting to today's `'spring'` so
  existing behaviour is unchanged, and the package exports
  `DOCUMENT_SCROLL_PHYSICS` (`{ stiffness: 180, damping: 27 }`, ζ ≈ 1.006) as the
  critically-damped document preset — measured at 0.00px overshoot and 0
  reversals over the same travel.

### Patch Changes

- 0987d47: Measure text on an attached canvas so Firefox advances match the painted glyphs.

  `RichText.baseMeasurer` and `measure.ts`'s shared context both created a canvas
  and never appended it, while the engine paints on the page's real attached
  canvas. Firefox resolves a generic CSS family (`monospace`, `sans-serif`)
  through a per-language font preference that is only reachable from a document
  style context, so the detached measurer fell back to a hardcoded 0.5em advance:
  it advanced every run 20% short of the glyphs actually drawn, and the following
  run landed on the tail of the previous one. The reported symptom was inline code
  overlapping the CJK text after it.

  Measured in a real `lang="zh"` document with the default code font, run
  `TextArea` followed by CJK, painted ink as ground truth (advance 76.8, last
  inked pixel x = 75):

  | engine   | detached (before) | attached (after) | overlap before → after |
  | -------- | ----------------- | ---------------- | ---------------------- |
  | Firefox  | 64.0              | 76.8             | **12.8px (16.7%) → 0** |
  | Chromium | 76.8              | 76.8             | 0 → 0                  |

  Both sites now go through a shared `createMeasuringContext()`, which appends a
  hidden 1×1 `aria-hidden` canvas. The invariant is _measure where you paint_
  rather than "get 76.8": in a document with no `<html lang>` Firefox genuinely
  paints at the 0.5em fallback, and the helper correctly reports 64 there too. The
  helper agreed with the real rendering canvas in all six engine × document
  combinations tested, where a detached context disagrees in Firefox whenever a
  `lang` is present. This also corrects `TextArea`'s wrap measurement, which used
  the same shared context.

  Chromium was self-consistent and is unaffected.

## 2.8.0

### Minor Changes

- b74f5d1: Allow naming the `RadioGroup` and `Tabs` container nodes.

  `RadioGroup` projected `role="radiogroup"` with the fixed label `Radio group`,
  and `Tabs` projected `role="tablist"` with `Tab switching panel`. Each option
  and each tab was already nameable, but the container was not — so a screen
  holding several groups announced them identically, and the name that says
  _which_ choice is being made was unavailable. Both now accept an optional
  `label`, defaulting to the previous literals, so existing consumers are
  unaffected.

### Patch Changes

- 324d0e7: Correct the `@vectojs/core` peer range to the version that actually satisfies
  its imports.

  `@vectojs/ui` declared `>=1.8.0 <2.0.0`, but `src/measure.ts` imports
  `getFontMetrics` and `fontMetricsVersion`. Those live in `@vectojs/text` and
  reach `@vectojs/core` only through its `export * from '@vectojs/text'`, so they
  appear no earlier than the core release that depends on text `0.3.0` —
  `@vectojs/core@1.25.0`. Verified by resolving both versions: on core `1.24.0`
  the two symbols are `undefined`, on `1.25.0` every symbol `@vectojs/ui` imports
  is present.

  Installing `@vectojs/ui@2.7.0` against a core in `1.8.0 … 1.24.0` therefore
  satisfied the declared range and then failed at import time with
  `SyntaxError: Export named 'getFontMetrics' not found in module @vectojs/core`,
  taking down any suite that touched the UI. The range now states the real floor,
  so a package manager reports the conflict up front. `@vectojs/markdown` already
  declared `>=1.25.0` for the same reason.

  No runtime code changed — this is a metadata fix.

## 2.7.0

### Minor Changes

- cafeb4e: Make focus rings and the open `Dropdown` menu themeable.

  `Button`, `Slider`, and `Dropdown` hardcoded the default palette's cyan
  (`#00f0ff`) and dark slate, so a light or warm theme could style a closed
  control but not its focus ring or its open menu — the menu opened as a dark
  panel with cyan selection and read as a rendering bug rather than a style.
  Sibling components (`ProgressBar.accent`, `Slider.progressColor`,
  `Tabs.selectedColor`) already exposed their colors; these were the holdouts.

  - `Button`: new `focusColor` option.
  - `Dropdown`: new `menuBg`, `menuColor`, `menuSelectedBg`, `menuHighlightBg`,
    and `focusColor` props. `focusColor` is forwarded to the trigger and to every
    option row.
  - `Slider`: new `focusColor` prop, plus a focus ring it previously **never
    drew at all** despite being keyboard-operable via arrows/Home/End — a
    WCAG 2.4.7 gap. It now tracks `focus`/`blur` and marks the scene dirty so
    render-on-demand scenes repaint the ring.

  Every default is unchanged, so existing themes render identically. Forced-colors
  mode continues to override all of them with the system `Highlight` color.

## 2.6.0

### Minor Changes

- 967f3ca: Reserve inline advance for a non-text object in a `StyledSpan`

  `RichText` could not hold horizontal space for anything it does not shape, so an
  inline formula, icon, or embedded box had no way to sit mid-sentence. The only
  workaround was a vertical `Stack` of alternating text runs and entities, which
  block-breaks the line.

  A span may now carry an `InlineObject`:

  ```ts
  import { OBJECT_REPLACEMENT, type StyledSpan } from "@vectojs/layout";

  const spans: StyledSpan[] = [
    { text: "the identity " },
    {
      text: OBJECT_REPLACEMENT,
      object: { width: 42, height: 20, depth: 4, alt: "x+1" },
    },
    { text: " holds." },
  ];
  ```

  The engine reserves `width` instead of measuring the character, sits the box on
  the shared text baseline (`depth` is how far it hangs below, matching MathJax's
  `vertical-align` with the sign flipped), and grows the line so a tall object is
  not clipped. Read the positioned box back off `LayoutNode.object` and draw your
  own content there — the engine never paints it, and `RichText` skips the
  sentinel rather than drawing a tofu box.

  `alt` supplies the accessible name and copied text in place of the sentinel.

  New exports from `@vectojs/layout`: `OBJECT_REPLACEMENT`, `InlineObject`.
  `StyledSpan`, `PreparedGlyph`, and `LayoutNode` each gain an optional `object`.
  Existing callers are unaffected: a span without `object` takes exactly the paths
  it did before.

- 9f97b64: Paint inline objects, and cover inline math in the real-browser e2e

  `InlineObject` gains an optional `paint(surface, box)` callback, invoked by
  `RichText` once per render at the box the layout engine reserved. Two supporting
  types are exported: `InlineObjectBox` (the resolved position, with `y` already
  offset for the object's `depth`) and `InlineObjectSurface` (the two `drawImage`
  overloads a painter needs — structurally a subset of `IRenderer`, declared in
  `@vectojs/layout` because that package sits below `@vectojs/core`).

  This fixes inline `$...$` math, which reserved its box correctly and then left it
  empty: the engine does not draw objects, and the span carried the formula's
  dimensions but not its raster. A correctly measured, positioned, and accessible
  formula rendered as a blank gap.

  The `@vectojs/markdown` change is a `patch` because it restores intended
  behaviour rather than adding API. It supplies a painter that draws the typeset
  SVG, decoding it once per formula into a module-level raster cache and
  repainting when it lands.

  `packages/markdown/e2e/lazy-math.e2e.ts` now covers inline math, including a
  pixel sample inside the reserved box. That assertion is the only one that can
  see this class of bug: no unit-test environment can: Bun has no `globalThis.Image`,
  and jsdom has one that never settles a `data:` URI.

- dc27a24: Reuse a streamed markdown table instead of rebuilding every cell.

  `Table` gains a public append-only `appendRows(rows)`. It reproduces exactly what
  the constructor does per row — normalize to the header's column count, reject a
  duplicate `Entity` cell, apply `selectable`, mount to the right parent for the
  current mode — then re-resolves geometry through `layout()`. It writes both the
  public `rows` and the private cell grid: `layout()` walks the grid while
  `getA11yAttributes()` counts `rows`, so updating only one produces a table that
  either renders rows it does not announce or announces rows it does not render.

  Append-only is deliberate. Existing row indices keep their meaning, so the roving
  tab stop cannot be invalidated and no `detachA11y` bookkeeping is needed. To
  change an existing cell, mutate the cell entity you passed in and call `layout()`,
  which re-measures from `cell.height`.

  `@vectojs/markdown` uses it for the last block type that still rebuilt. A `table`
  token carries every row, so the old path cost Θ(C·N²) cell constructions across a
  stream, plus a further 2× because `Table.layout()` re-runs `fitCell` on each one.
  Measured on real Chrome and Firefox with a growing-table benchmark shape,
  reuse-eligible on 27 of 36 chunks:

  | growing table | reconcile              | total                   |
  | ------------- | ---------------------- | ----------------------- |
  | Chrome        | 156.6 → 44.8 ms (−73%) | 314.8 → 193.8 ms (−41%) |
  | Firefox       | 98.0 → 29.3 ms (−70%)  | 250.5 → 177.1 ms (−28%) |

  Total moves as well as reconcile, because the rebuild was discarding and
  re-creating every cell entity.

  Handling row appends alone would not have delivered this. `marked` materializes a
  partially-arrived row immediately as a full row padded with empty cells and then
  fills them one at a time — a 2×2 table passes through eleven distinct row states,
  of which only two are clean appends. So the reuse path also rewrites the last
  row's cells in place, and markdown now renders every table cell as a `RichText`
  rather than letting an empty cell become a `Text`: `Text` has `setText`,
  `RichText` has `setSpans`, and nothing converts between them, so a cell that
  starts empty and later gains content could not otherwise be updated in place.

### Patch Changes

- ca20e66: Measure text correctly without a DOM

  `ARCHITECTURE.md` advertises Node server-side SVG generation and the `Scene`
  reference states that in SSR "headless layout / `toSVG()` still work". Layout did
  run, but every glyph advance came from a flat `0.5em` guess, because all four
  `GlyphMeasurer` factories return `null` without a canvas. Measured against Chrome
  at 32px `sans-serif`, widths were wrong by **+125% on narrow text and −47% on
  wide** — and `'iiiiiiiiii'` came out byte-identical to `'WWWWWWWWWW'`, since
  advances were not proportional at all. Wrapping inherited it, so line breaks
  landed in the wrong places too.

  `@vectojs/text` now owns a font-metrics registry:

  ```ts
  import { registerMSDFFontMetrics } from "@vectojs/text";

  // Only the JSON's advances, kerning, and metrics are read — the atlas image is
  // irrelevant, so a metrics-only file works and nothing needs to decode.
  registerMSDFFontMetrics("sans-serif", await Bun.file("inter.json").json());
  ```

  Any `msdf-atlas-gen` font works via `registerMSDFFontMetrics`, or supply a
  `FontMetricsSource` directly with `registerFontMetrics`. Three measurement paths
  consult it, all of which previously had their own hardcoded fallback: per-glyph
  advances in `@vectojs/layout`, whole-string widths in `@vectojs/ui` (which size
  `Button`, `Input`, `Link`, `Checkbox`, `ContextMenu`, and `ProgressBar`), and the
  baseline in `cssLineBoxBaseline`.

  **A real Canvas 2D context always wins**, so a browser is unaffected: verified in
  Chromium that a deliberately absurd registration changes no measured width by a
  single float. Registered metrics replace a fabricated guess; they never
  second-guess the engine that will actually draw the text.

  New in `@vectojs/layout`: `unmeasuredGlyphCount()` reports how many advances were
  fabricated, and a one-time console warning names the fix. This is distinct from
  `LayoutResult.fallbackToCanvas`, which only reports an _atlas_ miss and is true on
  essentially every paragraph even in a browser.

  One documented limit: the per-glyph `GlyphMeasurer` contract is
  `measure(char, fontSize, family)`, which has no neighbouring character, so summed
  advances cannot recover kerning — measured at ~10% on kern-heavy strings, against
  125% before. Whole-string measurement goes through `measureEm` and is exact.

- 4ab8aae: Revive the paragraph memo, and put `fontFamily` in its key.

  `LayoutEngine.prepare`/`prepareRich` discard every memoized paragraph when the
  atlas argument is not the **same object** as the previous call — glyph advances
  depend on it, so a changed atlas must invalidate. But `Text` and `RichText` both
  passed a fresh `{}` literal on every layout, so the memo was cleared each time and
  never hit: measured through the real `RichText`, five identical re-layouts produced
  **0 hits and 12 misses**. A cache with a 1000-entry bound, eviction counters, and
  ~20 references was dead code on the only paths that used it.

  Both now pass a new exported `EMPTY_GLYPH_ATLAS` (frozen, so one consumer cannot
  poison another's advances). Measured through `RichText` on 20 paragraphs, 40
  identical re-layouts: **54.52 ms → 26.78 ms**, hit rate **0 → 1.0**. Streaming
  markdown is unchanged, as expected — it re-lays out _growing_ text, which is the
  streaming shape cache's job, not the memo's.

  Reviving the cache exposed a latent correctness bug, so both are fixed together:
  `styleSig` fingerprinted `fontSize/color/bold/italic/href` but **not
  `fontFamily`**, even though `fontFamily` is passed to `glyphWidth` and changes
  advances. With a stable atlas, a `fontFamily: 'wide'` paragraph was served the
  metrics of an identical-length `'serif'` one — 48px where 144px was correct.
  Reachable in practice: `@vectojs/markdown` sets `fontFamily` on inline codespans,
  so any paragraph containing `` `code` `` was the colliding shape. `fontFamily` is
  now in the signature and in `styleRangeEquals`.

  `@vectojs/layout` is a minor for the new `EMPTY_GLYPH_ATLAS` export; `@vectojs/ui`
  is a patch (no API change, just correct cache usage).

## 2.5.0

### Minor Changes

- 734f1d0: `VirtualList`: track rows that keep resizing after they mount.

  A row's height was read once, on the frame it mounted, and never again — so a
  streaming Markdown row that kept growing never updated its Fenwick entry and the
  list's geometry drifted further from the truth with every chunk. Every mounted row's
  `height` is now re-read each frame and any change applied as an O(log n) point
  update.

  New `keyForItem` option. Supplying it gives stable row identity, which enables three
  things index identity cannot express:

  - **Measured heights survive `setItems`**, so appending to a transcript re-measures
    nothing. Previously `setItems` cleared every measurement and jumped to the top,
    which is right for a replaced list and wrong for a growing one. That remains the
    behaviour when `keyForItem` is absent.
  - **The scroll position is anchored across resizes.** If the viewport was following
    the bottom it keeps following; otherwise the row under the top edge stays exactly
    where it was, however much the rows above it changed height. The anchor keeps its
    offset _within_ the anchored row, clamped in case that row itself shrank.
  - **Prepend works.** A prepend shifts every index, so the pooled entities are rekeyed
    along with the heights.

  New `jumpToBottom()` — the instant counterpart to `scrollToBottom()`, and what
  streaming content should call. Retargeting the scroll integrator on every chunk never
  lets it settle, so the viewport chases the content instead of tracking it;
  `ScrollView.scrollToBottom` already snapped for this reason.

  New `stickToBottomThreshold` option (default `48`): how close to the bottom counts as
  "following". Following is latched at the last user scroll rather than re-derived when
  a row resizes, because a resize changes the distance to the bottom without the user
  having moved.

  Measurement is a poll rather than a notification. `Entity.width`/`height` are plain
  fields with no setter and no dirty flag, so there is nothing to subscribe to, and
  reading `ent.height` costs exactly what reading a version counter would — the check
  _is_ the work. Polling is also more general: it catches a height change by any
  mechanism, including a caller assigning `height` directly. The no-change path is one
  map lookup and one float compare per mounted row (~10-16) and deliberately does not
  mark the scene dirty, so the idle throttle is preserved.

  Two fixes fall out of this:

  - A row measured on its mount frame positioned every row below it against the stale
    estimate, so a freshly mounted variable-height row settled one frame late.
    `_reconcile` now mounts, then measures, then positions.
  - `Markdown.onLayoutUpdated` is documented as unnecessary for this (and as an
    incomplete size signal, since it fires from the append path but not from
    `setContent`). It has no callers and needs none.

### Patch Changes

- b153a6d: `RichText`: make wrapped links clickable on every visual line.

  A link now keeps one native semantic anchor while pooling a presentational pointer
  region for each wrapped line. Canvas and browser clicks both activate the link from
  continuation lines, and the empty tail beside a shorter line no longer activates it.

## 2.4.0

### Minor Changes

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

## 2.3.4

### Patch Changes

- 8c05163: Hiding an `Overlay` now hides its children from assistive technology too.

  `Overlay.hide()` dropped its own `interactive` and pruned its a11y subtree, which
  looked sufficient. It was not: the projection walk still descended into the hidden
  overlay, so any still-interactive **child** was re-created on the very next frame.
  Measured in a real browser — after `Popover.hide()` the popover's own element was
  gone while its button remained projected with `tabIndex: 0` and a live box, so a
  keyboard user could Tab into a hidden popover and activate it.

  `Entity.a11yHidden` is the new opt-out: it removes an entity **and its whole
  subtree** from projection regardless of each node's own `interactive` flag, for a
  container that is logically closed while still mounted. `Overlay.hide()` sets it and
  `show*()` clears it.

  Deliberately not inferred from `opacity`. `Overlay.hide()` springs opacity toward 0
  rather than assigning it, so mid-transition it reads nonzero (~0.26 when measured)
  and an `=== 0` test never fires — and a threshold would silently un-project a
  faint-but-live control.

- 06b2c73: Coalesce adjacent same-style glyphs into one `fillText`.

  `RichText.render` issued one `fillText` **per character**. Measured on a Markdown
  streaming workload, that was 369,324 calls over 400 appends — and `fillText`
  accounted for 71-84% of all entity painting, which itself was 92-99% of render.
  Shaping was not the problem: `measureText` was 0-5.7%.

  Runs of adjacent glyphs sharing font and colour are now drawn in a single call:

  | shape | `fillText` calls  | render (Chrome)     | render (Firefox)    |
  | ----- | ----------------- | ------------------- | ------------------- |
  | prose | 369,324 → 176,112 | 382 → 226ms (1.69x) | 346 → 228ms (1.52x) |
  | mixed | 142,728 → 30,798  | 142 → 61ms (2.33x)  | 144 → 58ms (2.50x)  |

  A run is only coalesced when its measured width equals the summed per-glyph
  advances. Layout positions each character from an isolated `measureText(char)`, so
  drawing them as one string would let the browser apply kerning and ligatures and move
  glyphs away from where layout put them — visible as text drifting from its selection
  overlay and hit box. The check costs one memoized `measureText` per run against what
  was one `fillText` per character.

  Whitespace, links and any positional gap (justification, tabs, bidi reordering) end a
  run, so those paths are unchanged.

  `CodeBlock` is unaffected — it self-draws a character grid rather than using
  `RichText`, so a code-heavy stream sees no change (247,380 calls before and after).

- 1620b74: Stop projecting `aria-setsize` on the `VirtualList` container.

  `aria-setsize` is defined on set **members**, not on the set itself, so putting it
  on the `role="list"` container is a disallowed attribute — axe reports it as a
  critical `aria-allowed-attr` violation. The count already reaches assistive
  technology through the container's accessible name, and per-row `posInSet`/`setSize`
  carry the position, which is what actually prevents a virtualized list being
  announced as "item 3 of 12".

  Introduced one release earlier alongside the new attributes, and caught by the axe
  suite when a virtualized list was added to the conformance fixture.

## 2.3.3

### Patch Changes

- ca22881: Add the `A11yAttributes` fields virtualization actually needs.

  Six new optional fields, each added because a component has state it currently
  cannot express — not to complete the ARIA surface:

  - `posInSet` / `setSize` (`aria-posinset` / `aria-setsize`)
  - `rowCount` / `rowIndex` (`aria-rowcount` / `aria-rowindex`)
  - `valueText` (`aria-valuetext`)
  - `orientation` (`aria-orientation`)

  The first four exist for virtualization specifically. A widget that mounts only its
  visible window leaves the accessibility tree unable to infer the real totals, so a
  list showing rows 40-52 of 10,000 is announced as "item 3 of 12" — the mounted
  window's size, not the list's. Stating the totals explicitly is the only fix.

  `VirtualList` now projects `setSize` with the real item count. Per-row
  `posInSet`/`setSize` belong in the caller's `renderItem`, since those entities are
  theirs; the class doc shows the pattern.

  All six are omitted when unset rather than emitted empty — `aria-setsize=""` is
  invalid, not "no set size".

## 2.3.2

### Patch Changes

- de369a1: Add an axe-core audit of the projected accessibility layer, and fix the three
  violations it found.

  VectoJS projects a real DOM shadow tree for semantics, so standard a11y tooling
  applies to that layer — and running it found bugs the hand-written conformance
  assertions could not, because those check what we thought to check.

  Fixed:

  - **`aria-valuenow` was emitted for every non-input element**, so a `combobox`
    reported `aria-valuenow="Small"` — a text value on a numeric attribute that is
    not allowed on that role, which axe flags as two separate critical violations.
    It is now restricted to the range roles it is defined for (`slider`,
    `spinbutton`, `progressbar`, `scrollbar`, `meter`).
  - **`Modal` had no accessible name.** Its title was drawn on canvas and never
    projected, so a screen reader announced a bare "dialog" with no indication of
    what it was for.

  Rules that cannot apply to a canvas runtime are disabled **with a stated reason**
  rather than silently ignored — notably colour contrast (the projected nodes are
  transparent; the visible pixels are canvas-drawn) and the two DOM-containment rules
  that a flat projection cannot satisfy.

## 2.3.1

### Patch Changes

- ddbe993: Trap Tab inside an open `Modal`.

  `Modal` projected `role="dialog"` with `aria-modal="true"` and moved focus in on
  open, but nothing constrained the browser's tab order — `aria-modal` tells
  assistive technology that outside content is inert, it does not stop Tab from
  leaving. Measured in real Chrome and Firefox: the first Tab after opening landed
  on a background control and successive presses walked the whole page behind the
  dialog, so a keyboard user was operating things they could not see.

  Tab and Shift+Tab now cycle within the dialog's own focusable elements, entering
  at the correct edge when focus arrives from outside. Escape-to-close and focus
  restoration already worked and are now covered by tests too.

  The trap is removed on `close()` and on `destroy()`, so a modal discarded without
  closing cannot leave a document listener trapping Tab for the page's lifetime.

- 8b3f10e: `RadioGroup` now handles Home and End.

  Arrow keys already moved within the group, but Home/End did nothing — focus stayed
  put. The ARIA radiogroup pattern requires both, and `Tabs` already implemented
  them, so the group was the odd one out.

  Home selects the first enabled option and End the last, scanning inward so a
  disabled option at either edge does not swallow the key. Landing on a disabled
  radio would be worse than not moving.

## 2.3.0

### Minor Changes

- de170fe: Add `Button.disabled` and `Input`/`TextArea` `required` + `invalid`.

  `A11yAttributes` has supported all three since the projection layer was written,
  but no component wired them, so an app could not express "this control is
  unavailable" or "this field failed validation" **at all** — visually or
  semantically. Found while building the a11y conformance fixture, which had to
  stand these in with local entities.

  ```ts
  new Button("Save", { disabled: true });
  new Input({
    width: 220,
    placeholder: "Email",
    required: true,
    invalid: true,
  });
  ```

  All three are also accessors, so state can change after construction and the drawn
  appearance and projected semantics move together. That coupling is the point: a
  control drawn as unavailable whose shadow node still reports enabled tells sighted
  and screen-reader users opposite things.

  `Button.disabled` gates activation on **both** input paths. The browser suppresses
  a DOM click on a disabled `<button>`, but the canvas hit-test dispatches
  independently, so without an explicit gate a disabled button still fired when
  clicked on the canvas. Hover and focus states are also suppressed.

  Under forced-colors mode the disabled and invalid states defer to system colours
  (`GrayText`, `LinkText`) rather than themed ones, since that mode exists so the OS
  picks contrast.

## 2.2.0

### Minor Changes

- 75b06a3: Add `label` to `Slider` and `Dropdown` so they can carry an accessible name.

  Both projected their ARIA role but had no way to supply a name, and neither set
  one. A screen reader announced them as bare "slider" and "combobox" with no
  indication of what they control — a WCAG 4.1.2 failure. Their visual labels are
  drawn on canvas, so nothing reached the semantic layer.

  ```ts
  new Slider({ min: 0, max: 100, value: 40, label: "Volume" });
  new Dropdown(["Small", "Large"], { label: "Size" });
  ```

  Omitting `label` leaves `aria-label` unset rather than fabricating a name from the
  value, since a wrong name is worse than a missing one.

  Found by driving the new a11y conformance fixture in real Chrome and Firefox and
  reading the browser's accessibility tree. Every unit test had passed over it,
  because jsdom has no accessibility tree to inspect.

## 2.1.0

### Minor Changes

- e3b745d: Add per-child ARIA roles + keyboard navigation to `TreeView`, `Table`, and
  `ContextMenu` (WCAG 2.1.1 / 4.1.2), completing the composite-widget a11y work
  started for RadioGroup/Tabs in PR #160. Each now projects transparent focusable
  hotspots over its canvas-drawn children so a screen reader and keyboard user can
  operate them:

  - **TreeView** — one `role="treeitem"` per visible row (virtualization-aware
    pool) with `aria-level`, `aria-expanded` (parents), `aria-selected`, and a
    roving tabindex. Keyboard: Up/Down move, Right expands / steps into children,
    Left collapses / steps to parent, Home/End, Enter/Space activate; the active
    row scrolls into view and takes focus.
  - **Table** — a real `grid > row > gridcell/columnheader` structure (pinned
    header row + one body `role="row"` per visible row, virtualization-aware),
    each cell a focusable hotspot with a roving tabindex. Keyboard: 2D arrows
    (clamped), Home/End (row extremes), Ctrl+Home/Ctrl+End (grid corners); the
    target cell scrolls into view and takes focus.
  - **ContextMenu** — one `role="menuitem"` per non-separator item with
    `aria-haspopup`/`aria-expanded` for submenu parents, `disabled`, and a roving
    tabindex. Keyboard: Up/Down (wrapping, skipping separators + disabled),
    Home/End, Right opens a submenu, Left returns to the parent menu, Enter/Space
    activate, Escape closes.

- 7b0d7f8: `RichText` now accepts `textAlign: 'left' | 'justify'` (+ a `setTextAlign()` method) and a `hyphenate` word-splitter. `justify` stretches every wrapped line flush to `maxWidth` (paragraph-final and newline-ended lines stay ragged); `hyphenate` breaks an overflowing word with a visible hyphen (soft hyphens U+00AD in the text work without one). Both pass straight through to the shared `LayoutEngine` — `RichText` already draws each glyph at its own position, so no rendering change was needed.
- e988a32: RichText justified selection now overlaps the drawn glyphs. On a justified line the engine widens inter-word gaps on the canvas, but the DOM content projection used natural-flow style runs, so the native selection box drifted off the widened words (real-hardware verified). RichText now projects a justified line as per-glyph positioned carriers — each at its own visual x, in logical source order (correct copy / screen-reader order), carrying the logical source substring (not the shaped glyph). Ragged (left-aligned) lines keep the cheaper natural-flow style runs, and per-run bold/italic/size fonts are preserved on both paths.
- 8749a9a: RTL / bidi text selection now overlaps the drawn glyphs. The engine right-aligns and visually reorders RTL lines, but the DOM content projection previously anchored every line at x=0, so the native selection box drifted off the glyphs (measured 300px+ on real Chrome). `Text` now anchors a bidi line's projection at its **visual origin** (the line's min glyph x) while keeping it a single natural-flow string in **logical** source order — so the browser's own bidi gives correct caret hit-mapping AND the selection rectangles overlap the canvas glyphs. RTL canvas text also renders glyph-by-glyph so it can actually right-align. Verified on real Chrome 150 + Firefox 153 across DPR 1/1.5, 90% zoom, and font-substitution cases. Left-aligned LTR text is unchanged.
- d4e6baa: Add touch / pointer **drag-to-scroll** to `Table` and `TreeView`, matching
  `VirtualList` and `ScrollView`. A virtualized `Table` previously only scrolled
  with a mouse wheel, and `TreeView` toggled a row on `pointerdown` — both were
  effectively unusable on a touchscreen. Now:

  - `Table` body follows the finger 1:1 (`pointerdown`/`move`/`up`), same sign
    convention as its wheel scroll.
  - `TreeView` drag-scrolls and defers the expand/collapse toggle to `pointerup`,
    firing it only when the pointer moved less than a small tap threshold — so a
    drag scrolls without accidentally toggling the row it started on, while a tap
    still toggles as before.

- fe98df9: Add opt-in virtualization to `Table`. Previously every cell was mounted and every row's chrome was drawn each frame, so a large data table's per-frame cost scaled with the total row count (and a 50k-row table meant 200k live cell entities + their content projections). Passing a `viewportHeight` now fixes the table to that height, pins the header, and scrolls the body — mounting (and projecting a11y for) only the body rows within the viewport plus a small overscan, laid out at a fixed `rowHeight` so scroll↔row-index is O(1). Wheel scrolling uses the same inertial integrator as `Tree`/`VirtualList`, and mounted cells stay fully selectable with correct DOM-vs-canvas geometry.

  Omitting `viewportHeight` keeps the classic behavior exactly: the table grows to fit all rows, every cell stays mounted, and rows keep their measured variable heights.

  Real-hardware benchmark (`benchmarks/table-virtual`, Chrome 150 + Firefox 153): the virtualized per-frame layout+sync cost stays flat at ~0.3 ms as the table grows, while the classic path grows linearly — at 5000 rows, 41 ms → 0.28 ms on Chrome (149×) and 49 ms → 0.26 ms on Firefox (190×). Text selection on the scrolled, clipped body audits `clean` on both engines.

- 7b0d7f8: `Text` now accepts `textAlign: 'left' | 'justify'` (+ a `setTextAlign()` method) and a `hyphenate` word-splitter. Left-aligned text keeps the fast one-`fillText`-per-line path; when justify or hyphenate is active, `Text` switches to a glyph-accurate render path (justify widens inter-word gaps flush to `maxWidth`, hyphenate breaks an overflowing word with a visible `-`). The DOM content projection still reports the original text unchanged, so find-in-page, selection, and screen readers are unaffected.

### Patch Changes

- e82102c: Add forced-colors (Windows High Contrast) awareness. `Scene` now exposes a
  `forcedColors` getter backed by a `(forced-colors: active)` media query and
  repaints when it toggles, so components can swap to CSS system colors — canvas
  pixels are exempt from the browser's forced-colors remapping. `Button` uses it
  to draw with `ButtonFace`/`ButtonText`/`Highlight` under High Contrast.
- 7e6f76d: Fix two interaction bugs found by verifying the suspected input/a11y list (three
  of the listed items turned out to need no change):

  - **Hover was never cleared when an entity was removed mid-hover**
    (`@vectojs/core`). Hover is driven by the projected shadow element's
    `mouseenter`/`mouseleave`; detaching that element fires no `mouseleave`, so an
    entity removed while the pointer was over it kept `hovered = true` forever —
    visible the moment it is re-added (a pooled virtualized row, a reopened menu) as
    hover styling with no pointer anywhere near it. Removal now synthesizes the
    `pointerleave`, including for hovered descendants of a removed subtree, and
    emits nothing when the entity wasn't hovered or had already left.
  - **IME composition over a selection painted a stale highlight**
    (`@vectojs/ui`). Composing over selected text logically replaces that range, but
    the native `<input>`/`<textarea>` keeps reporting the pre-composition
    `selectionStart`/`selectionEnd` until commit — so `Input` and `TextArea` drew the
    old selection behind (and wider than) the composition underline. The selection
    highlight is now suppressed while a non-empty composition is active.
  - **`TextArea` never drew a composition underline at all** (`@vectojs/ui`). It
    tracked `composition` but never used it, leaving a multi-keystroke IME
    conversion with no in-canvas feedback. It now underlines the composing range,
    per line so a wrapped composition is marked on every line it covers.

- b377c32: Four interaction / accessibility fixes:

  - **`Button` focus ring never appeared** — `render()` drew a ring when `focused`, but nothing set it. Button now syncs `focused` from the `focus`/`blur` events the Scene emits on its shadow `<button>`, so keyboard users get a visible focus indicator.
  - **`Link` opened two tabs** — the shadow `<a href target="_blank">` navigates natively on a real DOM click, and that click was also forwarded to the entity's handler which called `window.open` again. Link now skips `window.open` when the click is a genuine DOM click on an `<a>` (native navigation already happened), while still opening for canvas/Three/XR-path clicks where no anchor navigated.
  - **`Modal` had no dialog semantics** — it now reports `role="dialog"` + `aria-modal="true"` (new `A11yAttributes.ariaModal`, synced by `Scene`), closes on `Escape`, moves focus into the dialog on open, and restores focus to the previously-focused element on close.
  - **`Overlay.hide()` left it interactive and announced** — setting `opacity = 0` alone kept the overlay hit-testable, focusable, and read by screen readers. `hide()` now also clears `interactive` and prunes the a11y/portal shadow subtree (`detachA11y`); a later `showAt`/`showAtPoint` re-shows it and the per-frame sync re-creates the shadow nodes.

- 7b0d7f8: Fix DOM text-selection drift on justified text. `ContentProjectionRun` gains optional `x` / `width`: when set, the Scene lays the run out as a positioned carrier (`inline-block` + relative `left`) at the exact canvas x, the same technique the code-grid path uses. `Text` now emits positioned per-word runs on justified lines, so the native selection highlight overlaps the widened canvas glyphs instead of drifting left under the browser's natural inter-word spacing (verified on real Chrome). Left-aligned text is unchanged (no positioned runs, natural flow).
- cca3235: Two measured per-frame wins from the micro-walk survey (the rest of that list was
  measured and found not to be hotspots — see below):

  - **`measureText` shaped before checking its own cache** (`@vectojs/ui`). The LRU
    was keyed on the _shaped_ text, so every cache **hit** still ran
    `ArabicShaper.shapeArabic()` first — measured at ~60% of the whole hit cost
    (49.7ms of 83ms per 20k hits), and pure overhead for the ASCII majority where
    shaping returns the input unchanged yet still allocates an index map. The key is
    now the raw text and shaping happens only on a miss: **4.14µs → 0.34µs per hit
    (12×)**. Arabic is still measured in its contextually-shaped form — the change
    affects only _when_ shaping runs.
  - **`syncOverlayGeometry` re-wrote every overlay style every frame**
    (`@vectojs/core`). It assigned ten style properties per overlay layer on every
    synced frame even when the canvas box, logical size, and CSS↔logical scale were
    all unchanged — the normal case, since those only move on resize, zoom, or an
    ancestor scroll. It now memoizes the geometry it last wrote and returns early
    when nothing moved; the memo is invalidated when a WebGL/WebGPU layer is created
    lazily, so a brand-new layer is still positioned.

  Measured and **not** changed, to save the next person the investigation: the
  `scene` getter's parent-chain walk (`Entity.ts`) costs 0.14µs per read at depth 50
  (28.4ms per 200k reads) — caching it would add reparenting/attach invalidation
  complexity for no measurable gain.

- ed2614e: Make wrapping `Stack` (and `Flow`) appends O(1) instead of O(children). `Stack.add()` already had an O(1) fast path for the non-wrap, start-aligned case, but a **wrapping** stack fell back to a full `layout()` on every `add()` — so building a wrapping `Flow` one child at a time (a streaming list of chips/tags) cost O(children²) total. There is now an O(1) wrap fast-append that places each new child at the end of the current line (or the start of a new one) using persisted last-line state, recomputed at the end of each full `layout()` and updated per append. It runs under the same invariants as the existing fast path (`align: 'start'`, not immediately after a `remove()`) — start alignment is what makes it safe, since a later, cross-larger child on a line never shifts an already-placed sibling. Behavior is identical to a full re-layout (unit-tested for equivalence across both directions and a mid-stream `layout()`).

  Real-hardware benchmark (`benchmarks/stack-wrap`, Chrome 150 + Firefox 153): fast-append total build time stays ~0.5–1.4 ms as the child count grows, while the old full-layout-per-add grows quadratically — at 4000 children, 195 ms → 0.9 ms on Chrome (**213×**) and 173 ms → 1.4 ms on Firefox (**120×**).

- 63fc4b7: Two text-correctness fixes.

  **Text-default pictographs no longer count as double-width** (`@vectojs/text`). `PreparedContentGrid`'s `isWideCluster` treated every `Extended_Pictographic` code point as width-2, but `© ® ™ ☺ ✔ ❤` (and many others) are _text-default_ — width-1 unless an emoji variation selector (VS16) forces emoji presentation. This drifted the caret in the monospace content grid. A pictograph is now wide only when it carries VS16 or is `Emoji_Presentation` by default (and VS15 forces it narrow); flags, keycaps, and CJK are unaffected.

  **Inline `code` now renders (and measures) as monospace** (`@vectojs/layout`, `@vectojs/ui`, `@vectojs/markdown`). `TextStyle` gains an optional `fontFamily`, and `GlyphMeasurer.measure` gains an optional `fontFamily` argument, so a run in a different family lays out at its own metrics instead of the base font's. `RichText` honors it in both drawing (`nodeFont`) and measurement, and Markdown inline `codespan` now sets `fontFamily` to the theme's monospace stack — previously inline code was only tinted, rendered in the proportional prose font. Fenced `CodeBlock` was already monospace and is unchanged. Runs without `fontFamily` keep the component's base family (no behavior change for existing callers).

- ed68e3c: Two per-frame `@vectojs/ui` hot paths that scaled with content size are now flat:

  - **VirtualList row math**: `_totalH`/`_rowTop`/`_visibleRange` were O(items) and ran every scroll frame, defeating virtualization on long feeds. Replaced the height bookkeeping with a Fenwick prefix-sum tree (new exported `RowHeights`): `total()` O(1), `prefix()`/`indexAt()` O(log n), O(log n) point updates when a measured height replaces its estimate. Measured height caching and variable-row support are unchanged.
  - **RichText per-frame rebuild**: `visualLineGroups()` rebuilt the visual-line grouping (an O(glyphs) walk with `Math.max(...map())` per line) on every `render()` and every content-projection call. It is now memoized on the layout-`result` identity and invalidated whenever `layout()` produces a new result.

  Real-hardware benchmark (`benchmarks/ui-perf`, Chrome 150 + Firefox 153): VirtualList row math stays ~0.04–0.09 ms as the list grows while the previous linear scan reaches 391 ms (Chrome) / 165 ms (Firefox) at 500k rows — up to 4350× / 4130×. RichText memoized warm frames are ~0.0002 ms vs cold builds up to ~1.2 ms. Behavior is unchanged (all 357 ui tests plus new `RowHeights` and memoization regression tests pass).

## 2.0.0

### Major Changes

- e2cad3e: **Breaking:** `Markdown` and `CodeBlock` have moved to the new `@vectojs/markdown`
  package. `@vectojs/ui` no longer exports them and no longer depends on `marked`
  or `mathjax-full`, so apps that don't render Markdown no longer pull in those
  heavy dependencies.

  Migration: `import { Markdown, CodeBlock } from '@vectojs/ui'` →
  `import { Markdown, CodeBlock } from '@vectojs/markdown'` (add the
  `@vectojs/markdown` dependency). Everything else in `@vectojs/ui` is unchanged.

## 1.11.6

### Patch Changes

- 923af95: Fix `Markdown`'s streaming Worker sending the entire re-lexed token tree back over `postMessage` on every single streamed chunk, even though only a small suffix of tokens is usually new. `marked` has no incremental lexing API, so the Worker still re-lexes the whole accumulated text each time, but for a large streamed document the resulting token tree itself could reach several megabytes — and structured-cloning that whole object graph across the thread boundary on every chunk was a real, escalating cost independent of the lex compute itself. The Worker now diffs against the caller's own previous tokens (by raw source, the same technique `updateTokens()` already uses) and sends back only `{ matchLen, tail }` — the changed suffix — cutting per-chunk transfer size by roughly two orders of magnitude on a large real-world document. `Markdown.appendMarkdown()` now also coalesces to at most one in-flight Worker request (required for the snapshot this diff is computed against to stay valid), further reducing round-trip count for fast streams.

## 1.11.5

### Patch Changes

- 99b3f52: Fix `Markdown.updateTokens()` calling a full O(children) `Stack.layout()` on every single streamed chunk, even in the common case where only the actively-growing last paragraph changed (via `setSpans()`) with no other structural change. This bypassed the O(1) `Stack.add()` fast-append path entirely and made per-chunk cost scale with total mounted paragraph count, causing frame rate to degrade progressively as a streamed document grows and leaving the last few frames before completion disproportionately slow. Added `Stack.resizeLastChild()`, an O(1) resync used when the Stack's last child changes its own size in place, and use it from `updateTokens()` instead of the unconditional full `layout()` call.

## 1.11.4

### Patch Changes

- 21e6385: Fix `Stack.add()` performing a full O(children) `layout()` on every single call, which made total layout cost for an N-child stack scale as O(N^2). Streamed content built by repeated `add()` calls (e.g. one Markdown paragraph per token) now appends in O(1) for the common case (no `wrap`, `align: 'start'`), falling back to a full `layout()` for wrapping, non-start alignment, or right after a `remove()` (to resynchronize stale size/position state). `Flow` (always `wrap: true`) is unaffected.

## 1.11.3

### Patch Changes

- 7684793: Give every ContextMenu backdrop a root-menu-scoped identity and dismiss it on pointerdown, while retaining semantic click activation. Rapid close-and-reopen cycles can no longer route an outside click to a stale backdrop owner and leave the replacement menu open.

## 1.11.2

### Patch Changes

- f797eeb: Remove the ContextMenu semantic and pointer hit surface while hidden, then
  restore it when reopened, so visual dismissal and browser automation agree.

## 1.11.1

### Patch Changes

- 070b112: Keep nested ContextMenu overlays semantically distinct and lifecycle-safe by
  sharing one root backdrop and closing or destroying the complete menu chain.

## 1.11.0

### Minor Changes

- 9a4d060: Added a container sizing contract: `Panel.setContent(content, fit?)` and `Card.setContent(content, fit?)` keep hosted content's `width`/`height` synced to the container's own box, defaulting to tracking both axes (`fit` accepts `true` | `false` | `{ width?, height?: boolean }`). Previously `Panel.setContent` only positioned its content (`content.x = 0; content.y = 0`), never sized it — while `PanelGroup` correctly resized its `Panel` children, the chain dead-ended there, requiring every app to hand-sync `child.width = panel.width` itself (the exact gap that caused a 3.2px clip-overflow in a real forge app, findings.md 2026-07-10). `Card` gains the same contract for consistency, plus a new `onClick` option (`Card.ts`, same pattern as `Button`) so a whole card can be made clickable without stacking a transparent `Button` over it — `onClick` requires `label` (throws otherwise), so the a11y projection always has an accessible name for the interactive region it creates.

  `Tabs`, `PanelGroup`, `Stack`, and `Flow` are unchanged — `Tabs` already sizes its hosted content correctly, and `PanelGroup` already sizes its immediate `Panel` children; the gap was specifically `Panel.setContent`'s next link. See `vectojs-docs/superpowers/specs/2026-07-17-container-sizing-contract-design.md` for the full design and scope decisions (notably: `RichText`'s `whiteSpace: 'pre'` mode is a separate, deferred design — the two-formula line-advance discrepancy it depends on needs its own root-cause pass first).

## 1.10.1

### Patch Changes

- ad20c45: Fixed `ContextMenu.showAtPoint(x, y, source?)`: its override dropped the `source` arg entirely when forwarding to `Overlay.showAtPoint` (added in 1.10.0), and its own scene-resolution check (`this.scene`) ran before `source` could help — so a freshly-constructed `ContextMenu`'s first `showAtPoint(x, y, someEntity)` call still silently no-opped, the exact bug 1.10.0 was supposed to fix for every `Overlay` subclass. `Overlay._sceneFromSource` (the resolver `showAtPoint` uses) is now `protected` so subclasses that override `showAtPoint` share one resolution path instead of drifting out of sync with it.

  Added a component conformance test suite (`packages/ui/test/ComponentConformance.test.ts`) covering every `@vectojs/ui` component against five checks: unique ids + independent event routing across instances, defined (non-silent-no-op) behavior for pre-mount API calls, `hasPendingAnimations()` reporting for any triggered animation, parent-resize tracking (or a documented exemption), and leak-free `destroy()`/`remove()`. This is what caught the `ContextMenu` regression above.

## 1.10.0

### Minor Changes

- 6b28d5f: `Overlay.showAtPoint(x, y, source?)` accepts an optional `source` — either a `Scene` or any mounted `Entity` — used to resolve the scene when the overlay has no `parent` yet. This fixes a long-standing silent no-op: `Entity.scene` walks the parent chain, so a freshly `new ContextMenu({...})` (or any `Overlay` subclass) has `scene === null`, and the method's first-line `if (!this.scene) return;` bailed before the auto-mount could run. The documented "bare constructor + showAtPoint" pattern now works on the very first call when `source` is passed (the typical `source` is the entity whose `pointerdown` listener is opening the menu — e.g. `menu.showAtPoint(event.sceneX, event.sceneY, target)`). Callers that already pre-mount via `scene.add(menu)` or `scene.overlayRoot.add(menu)` continue to work unchanged; the no-arg `showAtPoint(x, y)` form still silently no-ops on an unmounted instance for backward compatibility. Applies to `ContextMenu`, `Tooltip`, and `Popover`.

## 1.9.5

### Patch Changes

- 6b1bde0: Tabs: new opt-in `autoHideTabBar` option (Vim `showtabline=1` semantics) — the tab bar hides while there are fewer than two tabs and the content occupies the full height, reappearing as soon as a second tab is added. The hidden strip is inert for pointer input, `effectiveTabBarHeight` exposes the current bar height for owners laying out around it, and content geometry now re-syncs every frame so direct `tabs` field reassignment (without a `change` emit) can no longer leave the active content offset or stale.

## 1.9.4

### Patch Changes

- 9ca4dba: Fix duplicate-instance entity id collisions and wrong-tab closes:

  - Eleven components (Overlay, Tabs, RadioGroup, ProgressBar, ScrollView,
    PanelResizeHandle, Panel, PanelGroup, TreeView, VirtualList, Stack) passed
    their class name to `Entity(id)` as the entity id, so every instance in a
    scene shared one id. The accessibility projection keys its shadow-element
    map by id, so duplicate instances shared a single DOM element and pointer
    events routed to whichever entity claimed the id first — e.g. with two
    nested PanelGroups, dragging the inner split divider resized the outer one.
    Instances now receive unique generated ids (devtools type labels come from
    the constructor name and are unaffected).
  - `Tabs` no longer stretches tabs to fill surplus bar width: a stretched tab's
    right-edge × rendered directly beside the next tab's label, and users
    closed the wrong tab. `tabWidth` is now the maximum; extra strip width
    stays empty.

## 1.9.3

### Patch Changes

- 9711fdf: Keep the Input/TextArea caret blinking under the idle throttle. The blink phase
  comes from `Date.now()` inside `render()`, which the Scene's idle detection
  cannot see, so a focused field in an `onDemand` scene froze its caret solid
  (and blinked erratically under the 2 FPS auto-throttle). A focus-scoped
  wake-up now marks the scene dirty at each 500 ms phase boundary and is cleared
  on blur and destroy. Also regenerated `MarkdownWorkerSource.ts` from the
  current `marked` version and wired `scripts/build-worker.js` into the build so
  the generated worker can no longer drift from the lockfile.

## 1.9.2

### Patch Changes

- 85f152a: Add a lightweight `@vectojs/ui/context-menu` entry and update the ContextMenu
  example to use current VectoJS pointer events and scene coordinates.

## 1.9.1

### Patch Changes

- 890173c: Fix `ContextMenu` staying open with no way to dismiss it, and its keyboard-shortcut hint overflowing the panel's right edge.

  - `showAtPoint` now mounts a full-screen invisible backdrop behind the menu while it's open; clicking anywhere outside the menu (or a nested submenu) closes it, matching every native context menu. Previously the only way to close it was clicking one of its own non-disabled items.
  - The `shortcut` hint (e.g. `Ctrl+C`) is now measured and its draw position offset so its right edge lands at the panel's inset, instead of always starting at `width - 12` and running rightward past the border for anything longer than a couple of characters.

## 1.9.0

### Minor Changes

- d87add3: Share one source-aware prepared grid between CodeBlock canvas paint and semantic DOM projection. Grid geometry now preserves UTF-16 source ranges, grapheme clusters, tab stops, wide CJK/emoji cells, Arabic shaping, and bidi visual positions while retaining exact native copy/find text.

  Calibrate projected grapheme carriers after font loading so Firefox font substitution, DPR, CSS zoom, transforms, and forced colors keep selection geometry aligned without synchronous layout reads in the projection hot path. Text-selection routing now uses prepared local caret boundaries for ink and blank regions, preserves Shift/word/line/reverse selection semantics, cleans up rebuilds and lost mouse releases, and keeps structural Table semantics from intercepting selectable cell projections.

  Route ordinary Text, RichText, and line-less custom projections through transformed two-dimensional grapheme caret geometry, including rotated, mirrored, and non-uniformly scaled content.

  Deduplicate cold font samples and reuse each line's source segmentation. On the release workstation, the 80,000-input-cluster preparation mean fell from 247.16 ms to 65.08 ms for ASCII and from 265.88 ms to 77.77 ms for mixed Unicode. `@vectojs/ui` 1.9 requires `@vectojs/core` 1.8 or newer within the 1.x line.

## 1.8.1

### Patch Changes

- Fix text selection and CodeBlock rendering

  **@vectojs/core**

  - Fix text selection not starting from whitespace/padding regions within selectable entities (e.g. CodeBlock padding area). Removed `overflow: hidden` from content projection divs — the a11y overlay root handles viewport clipping.
  - Fix selection disappearing when the mouse is dragged outside an entity's bounds. The a11y root now temporarily promotes to `pointer-events: auto` during an active selection drag so the browser can extend the Selection Range across entity boundaries, matching native DOM selection behavior.

  **@vectojs/ui**

  - Fix CodeBlock character spacing collapse on Firefox desktop. Firefox's Canvas2D applies OpenType ligatures to monospace fonts, causing `measureText('office')` to return the ligated `ffi` width instead of 6 × cellWidth. CodeBlock now uses pure grid positioning (character count × cell width) instead of the hybrid `Math.max(grid, measured)` approach, eliminating cross-browser rendering differences.

## 1.8.0

### Minor Changes

- c39a440: Preserve logical source text and native selection geometry across positioned multiline content projections. Visual line separators now belong to their preceding line instead of creating root-origin selection fragments; Text and RichText keep soft wraps, hard breaks, CJK, ligatures, and RTL source order intact; CodeBlock uses a platform monospace-first fallback. Chromium and Firefox browser coverage now includes keyboard copy/paste, Noto Serif substitution, forced colors, DPR and zoom variants, Markdown lists and tables, and standalone Table cells.

## 1.7.2

### Patch Changes

- 38b3b8b: Align selectable DOM text and native editor shadows with Canvas 2D baselines, including explicit visual-line projections for mixed typography and code blocks.

## 1.7.1

### Patch Changes

- 2c0441d: Add a lightweight `@vectojs/ui/text` entry so canvas applications can consume selectable static text without loading Markdown and MathJax dependencies.

## 1.7.0

### Minor Changes

- fc96dfa: Make browser-native text selection a reusable VectoJS contract. Core now keeps dynamically
  materialized content projections in VMT order, removes them with their subtree, hides projections
  outside clipping ancestors, and exposes `Scene.getContentElement()` for tooling. UI adds
  configurable selection to Text, RichText, Markdown, CodeBlock, and Table cells; projects fenced
  code; preserves RichText wrap points; and gives Table an explicit, render-pure layout pass with
  wrapped, single-owner cell projections. UI's Core peer range is also aligned with its stable API
  contract (`>=1.0.0 <2.0.0`). DevTools event traces now report `source: "content"` for events
  originating on projected selectable text.

## 1.6.3

### Patch Changes

- Add `tableBgColor` and `tableHeaderBgColor` to `MarkdownTheme` so applications can style Markdown table surfaces without replacing the Table renderer.

## 1.6.2

### Patch Changes

- Native text-selection fidelity and Markdown fixes:

  - `Text` is no longer `interactive`: its own invisible a11y node sat above the selectable projection and swallowed the mousedown, so plain `Text` could never be mouse-selected (`RichText` already opted out).
  - `Text` projects its rendered lines (wrap points as `\n`) and drawn `lineHeight`; `RichText` projects the engine line advance — selection and find-in-page highlights no longer drift on multi-line text.
  - Markdown: `<br>` inside table cells (and hard-break tokens) now render as real line breaks instead of literal `<br>` text; other inline HTML tags are no longer printed as visible text.
  - Markdown streaming: a worker parse error now falls back to a synchronous main-thread parse instead of silently dropping the update (the final chunk of a stream could vanish); a crashed worker flushes all pending parses and detaches.
  - `Table`: entity cells are wrapped via `setMaxWidth()` — the previous bare field write never reached the layout engine, so cell content never wrapped to its column.

## 1.6.1

### Patch Changes

- f93ff3b: Add lightweight `@vectojs/ui/input` and `@vectojs/ui/measure` subpaths so focused applications avoid bundling Markdown, MathJax, and unrelated UI components.

## 1.6.0

### Minor Changes

- feat(ui): support raw SVG HTML blocks and images in Markdown paragraphs

## 1.5.0

### Minor Changes

- Support projecting `target` attribute to accessibility DOM node in `@vectojs/core`. Render MathJax SVGs with intrinsic dimension measurements to maintain responsive sizing in `@vectojs/ui`. Map `target="_blank"` on links to prevent canvas escape in interactive modes.

## 1.4.0

### Minor Changes

- Add MathJax inline and block support to Markdown component, and utilize a Web Worker to parse Markdown AST asynchronously to ensure smooth Canvas rendering without main thread blocking during high-speed text streaming.

## 1.3.0

### Minor Changes

- fe162c8: - Fix massive memory leak in `Entity.remove()` causing A11y DOM nodes to orphan and leak memory.
  - Upgrade `Table` to support `Entity` children allowing for inline Markdown styling inside cells.
  - Fix `MarkdownView` FPS drops during streaming by dynamically throttling AST evaluations.

## 1.2.0

### Minor Changes

- - Fix massive memory leak in `Entity.remove()` causing A11y DOM nodes to orphan and leak memory.
  - Upgrade `Table` to support `Entity` children allowing for inline Markdown styling inside cells.
  - Fix `MarkdownView` FPS drops during streaming by dynamically throttling AST evaluations.

## 1.1.3

### Patch Changes

- 94f6faf: ResizablePanel: drag the divider in scene space instead of the handle`\s local space, so resizing tracks the cursor 1:1 (the handle moves with the panel it resizes, so a local coordinate lagged the pointer); a drag no longer aborts when the cursor briefly outruns the thin handle. Tabs: add `closable`/`onClose`(per-tab × affordance), and keep a fixed`tabWidth`(default 160, floor`minTabWidth`96) with horizontal wheel scrolling + auto-scroll-to-active instead of shrinking to slivers as the tab count grows; long labels truncate with an ellipsis. Tree:`TreeNode.iconColor` for material-style colored file icons.

## 1.1.1

### Patch Changes

- fix(ui): prevent character overlapping in CodeBlock rendering under fallback proportional fonts

## 1.1.0

### Minor Changes

- 224e6d5: Extract the blockquote overlay's anonymous non-layouting `Entity` subclass into a named, reusable `MarkdownContainer`, and use it to wrap each blockquote inner-token element so the wrapper's reported width includes the 16px indent offset — previously the indent shifted the element visually but wasn't reflected in any parent's width accounting, which could understate a blockquote's true content width when it contained wrapped or indented nested elements.

## 1.0.0

### Major Changes

- First stable release. All core engine features (scene graph, layout, hit-testing, animation drivers, WebGL/WebGPU/Canvas2D/SVG rendering, accessibility projection, text shaping/bidi) and the full UI component set have shipped and been through a complete file-by-file audit of both packages, with a live-interaction QA pass across every demo and renderer backend. No known bugs or vulnerabilities remain open.

  This is a semver commitment: breaking changes to the public API of either package now require a major version bump.

## 0.2.8

### Patch Changes

- 01c8abc: Fix `Markdown`'s blockquote rendering: the left accent border and the quote text were meant to overlay at the same position, but were built inside a `Stack`, whose `add()` re-runs sequential auto-layout on every call — silently moving the text below the border instead of overlaying it, while the container still reported a height that didn't cover the (mis)placed text. The overlay container is now a plain, non-layouting entity, so the border and text render together as intended.
- da1c45c: Fix `ContextMenu` showing the wrong submenu content: the submenu instance was lazily created once and reused for every item with `children`, tracked by a single `_submenu` field with no record of _which_ item it represented. Opening a second submenu item just repositioned the first item's still-showing submenu instead of building one for the newly-clicked item. The submenu is now rebuilt whenever a different item is opened.
- 33a3939: `Input` no longer re-scans the entire value for RTL-script characters on every `charOffset()` call. The scan ran uncached, and a single render (or caret blink) tick could call `charOffset()` several times (caret position, selection start, selection end, composition bounds) plus once more inline in the selection-highlight branch — each redoing the same O(n) scan from scratch. It's now cached alongside the existing layout cache, invalidated only when `value` changes.
- 0cca389: Fix `Tooltip` and `Popover` leaking a listener on their target entity: both registered a `hover`/`click` closure directly on the caller-supplied `target` without ever removing it, so destroying a `Tooltip`/`Popover` while its target stayed alive left the target holding a reference to the dead instance — a later hover/click would resurrect the destroyed overlay back into the scene tree instead of being a no-op. Both now store the handler and detach it in `destroy()`.
- 3de7bcc: Fix `TreeView`'s lazy-load spinner disappearing prematurely: the `loading` flag was mutated directly on the `FlatRow` object captured before the `await`, but a sibling lazy node resolving in the meantime calls `_buildRows()`, which replaces `this._rows` with entirely fresh row objects (always defaulting `loading: false`). The original row's later `loading = false` then mutated a detached, no-longer-rendered object — leaving the still-pending node's row showing no spinner and no children until its own load finished. `loading` is now tracked in a `Set<string>` on the TreeView itself and read by `_buildRows()`, so it survives rebuilds triggered by other in-flight loads.

## 0.2.7

### Patch Changes

- a2d7d3b: Text and RichText mirror their rendered text into the DOM content layer (core 0.2.7 content projection) — Markdown bodies become findable, screen-reader-visible, and translatable automatically since Markdown composes these components.

## 0.2.6

### Patch Changes

- f4c98f3: Slider now supports Arrow/Home/End keyboard input (making its slider role honest) and a configurable step for both pointer and keyboard, snapped on a min-anchored grid.
- e45ec38: - `VirtualList` and `TreeView` scroll animations are now visible to the Scene's idle throttle / onDemand skip via `hasPendingAnimations()` — smooth scrolling no longer steps at 2 FPS (or stalls in onDemand mode) once the throttle engages. Same regression class as the earlier ScrollView fix.
  - `Tooltip` restarts (instead of stacking) its show-delay timer on repeated hover, and cancels it on `destroy()`.

## 0.2.5

### Patch Changes

- Fix form-control redraws in on-demand scenes, stabilize CodeBlock spacing, and keep resizable panel sizes bounded after resize.

## 0.2.4

### Patch Changes

- Forward `MarkdownOptions.onLinkClick` through paragraph, heading, and list `RichText`
  renderers, and make `Markdown.renderToken()` protected so custom Markdown renderers can
  subclass safely without patching internals.
- Mark interactive state changes dirty in `Button`, `Slider`, `Checkbox`, and `Toggle` so
  `onDemand` scenes repaint immediately during hover, drag, checkbox, and switch updates.

## 0.2.3

### Patch Changes

- Use the shared affine local-coordinate contract for interactive controls, position overlays from
  transformed world bounds, reject executable link schemes, and align accessibility behavior across
  the component library.

## 0.2.2

### Patch Changes

- 6335e42: Fix `ScrollView.scrollToBottom()` retargeting the scroll spring on every call instead of snapping instantly. Callers that track growing content (e.g. a streaming chat auto-following new tokens) call this many times a second, which never let the spring settle — the viewport visibly jittered instead of tracking the newest content. Wheel/drag scrolling is unaffected and still springs.

## 0.2.1

### Patch Changes

- 40182bd: Fix choppy/stepped motion for any in-flight `setTransition`/`animateTo`/`springTo` animation in the default `always` render mode: `Entity.hasPendingAnimations()` didn't check active property drivers, so once Scene's idle auto-throttle engaged, an animation only advanced one frame per external `markDirty()` call instead of every render frame (a `markDirty()` called from inside `update()` is wiped by the loop's own `dirty = false` at the end of that same tick — only `hasPendingAnimations()` reliably holds the throttle off across frames).

  `ScrollView` is refactored to drive its content's scroll offset through this shared, dt-aware spring system instead of a hand-rolled, frame-rate-dependent integrator, fixing both the throttle-invisibility and the dt-independence in one pass. This is most visible in the AI Chat demo, where scrolling now glides continuously alongside token-by-token streaming instead of stepping in bursts synchronized to token arrival.

## 0.2.0

### Minor Changes

- 21cea39: Add a unified, spring-first animation system.

  `@vectojs/core` gains an easing library (`Easing`), per-property spring/tween
  drivers, and a declarative + imperative API on `Entity`: `setTransition` (assign
  a configured property and it animates), plus `animateTo` / `springTo` (imperative,
  Promise-returning). The six transform/visual properties (`x`, `y`, `scaleX`,
  `scaleY`, `rotation`, `opacity`) are now accessors with a zero-overhead fast path
  when no transition is configured (benchmarked: 5000 writes/frame ≈ 89µs, 0.5% of a
  60fps budget). Legacy `Entity.animate()` is preserved. Adds an `onMounted`
  lifecycle hook and honors `prefers-reduced-motion` (movement snaps, opacity fades).

  `@vectojs/ui` gains a shared enter/exit presence helper on `UIComponent`
  (`enterMotion` / `exitMotion` / `dismiss`). `Modal` and the `Overlay` family
  (`Tooltip` / `Popover` / `ContextMenu`) now animate through the shared system,
  replacing their bespoke `SpringPhysics` and hand-rolled lerps.

- c889611: Add Overlay (shared positioning engine), VirtualList (virtual scrolling with fixed and variable heights), TreeView (eager and lazy child loading), ResizablePanel (PanelGroup, Panel, PanelResizeHandle for N-panel nested resizable splits), Tooltip (hover trigger), Popover (click trigger), ContextMenu (right-click, separators, nested submenus), RadioGroup (horizontal/vertical option groups), Tabs (tabbed panel container), and ProgressBar (filled indicator bar with text display option) components.

## 0.1.1

### Minor Changes

- c8896118: Added ten new native UI components: `Overlay`, `VirtualList`, `TreeView`,
  `ResizablePanel`, `Tooltip`, `Popover`, `ContextMenu`, `RadioGroup`, `Tabs`, and
  `ProgressBar`.

### Patch Changes

- c8896118: Aligned `Toggle`, `Checkbox`, `Input`, `Dropdown`, and `Slider` so their change
  callbacks fire through the same consistent shape.

## 0.1.0

### Minor Changes

- c74bb7bd: Renamed from `@vecto-ui/ui` to `@vectojs/ui` and reset the version to `0.1.0`,
  matching the same-day `@vectojs/core` rescope. See that package's changelog for details.
  This is a clean version reset, not a feature release.

---

## Pre-rebrand history (`@vecto-ui/ui`)

Everything below shipped under the old `@vecto-ui` npm scope, before the 2026-07-01 rename
and version reset. Kept for historical reference — none of these version numbers exist under
the current `@vectojs/ui` scope.

## 0.4.2

### Patch Changes

- Refactor core package into modular subpath exports (`./layout`, `./renderer`, `./text`) and introduce static registration APIs (`Scene.registerWebGLPointRendererCreator`, `Scene.registerWebGPUParticleSystemManager`) for pluggable backends.
- Updated dependencies
  - @vectojs/core@0.9.2

## 0.4.1

### Patch Changes

- Fix WebGPU particle vertex storage binding and align CPU/GPU spring limits. Adjust Scene maxFPS to default to 60 with idle auto-throttling. Fix ScrollView stability and expose public scroll APIs. Add GFM Table support to Markdown component. Adjust UI peerDependencies.
- Updated dependencies
  - @vectojs/core@0.9.1

## 0.4.0

### Minor Changes

- Add high-performance WebGPU Compute-Shader based particle system simulation and UAX #9 compliant bidirectional (BiDi) text layout engine with Arabic/Hebrew/Persian contextual shaping, along with caret navigation and visual highlights in Input and TextArea.

### Patch Changes

- Updated dependencies
  - @vectojs/core@0.9.0

## 0.3.3

### Patch Changes

- Updated dependencies
  - @vectojs/core@0.8.0

## 0.3.2

### Patch Changes

- feat(a11y): strengthen a11yRoot with strict DFS DOM ordering, typing synchronization protection, and full WAI-ARIA keyboard navigation for Dropdown.
- Updated dependencies
- Updated dependencies [cd3e3e8]
  - @vectojs/core@0.7.1

## 0.3.1

### Patch Changes

- Updated dependencies [3dfbfd4]
  - @vectojs/core@0.7.0

## 0.3.0

### Minor Changes

- a964f1c: feat(ui): add Flow layout component and Stack wrap support

  - `Stack` now accepts `wrap`, `maxWidth`, and `maxHeight` options. When
    `wrap: true`, children overflow onto the next line when the main-axis
    extent exceeds the limit — producing a CSS flexbox-like flow layout.
    Existing non-wrapping Stacks are unaffected (backward compatible).
  - Added `Flow` convenience component: a `Stack` pre-configured with
    `direction: 'horizontal'` and `wrap: true` — the most common use case
    for responsive tag/chip/card layouts.

- aa5e473: Streaming Markdown plus a wider component suite.

  - **`Markdown`**: a canvas Markdown renderer with `setContent()` and `appendMarkdown()` for streaming/LLM output — unchanged prefix paragraphs are reused and a growing paragraph is appended in place, activating the `LayoutEngine` paragraph memo so live output doesn't re-render the whole document. Inline tokens (bold/italic/code/links, with a11y projection) map to `RichText`; a highlighted code block collapses to a single `CodeBlock` leaf entity instead of N×M child entities.
  - New components: `Table`, `Dropdown`, `Slider`, `Modal`.

### Patch Changes

- 382e34f: Text flow around exclusion rects (战役一, PR B — "文字绕流" v1): text can now wrap around rectangular regions, like CSS floats.

  - **`@vectojs/core`**: new pure `computeLineSegments(top, bottom, maxWidth, exclusions)` returns the free horizontal segments left on a line after subtracting the `ExclusionRect`s that overlap its band (left/right floats narrow the line; a centered rect splits it in two; a full-width one skips the band). `LayoutEngine.layoutPrepared` takes an optional third `exclusions` argument and flows words across those per-line segments. New exports: `ExclusionRect`, `LineSegment`, `computeLineSegments`. The single-column path (no exclusions) is byte-for-byte unchanged.
  - **`@vectojs/ui`**: `RichText` gains an `exclusions` option and a `setExclusions()` method.

- b5e2c76: Inline rich-text flow (战役一, PR A): bold / italic / colored / differently-sized runs that flow and wrap on the same lines, sharing a baseline.

  - **`@vectojs/core`**: new `LayoutEngine.prepareRich(spans, atlas, baseFontSize, baseStyle?)` cold pass taking `StyledSpan[]`. Each grapheme carries the (base-merged) `TextStyle` of the span it came from — so a style change _mid-word_ is honored — and is measured at its run's `fontSize`. `layoutPrepared` now baseline-aligns mixed sizes (tallest run on a line drives line height; smaller glyphs drop to the shared baseline) and carries `style` onto each `LayoutNode`. New exports: `TextStyle`, `StyledSpan`; `PreparedGlyph`/`LayoutNode` gain an optional `style`. Plain (single-style) layout is unchanged.
  - **`@vectojs/ui`**: new `RichText` component — renders styled runs via the engine's rich path, drawing each glyph with its run's color and weight/slant.

- 90a4339: Inline links in rich text (战役一, PR A.5): a `{ href }` run in a `RichText` is underlined and painted in the link color on the canvas, and projects a real, operable `<a href>` shadow node so screen readers announce it and automation agents (Playwright / AI) can find it by href and click it — routing back to `onLinkClick`.

  - **`@vectojs/core`**: new public `Scene.detachA11y(entity)` to prune the shadow node(s) of an entity subtree on demand. Interactive _child_ entities (e.g. per-link hotspots) call this when they are removed, so the per-frame `syncA11y` (which only creates/updates) never leaks stale nodes.
  - **`@vectojs/ui`**: `RichText` gains `linkColor` and `onLinkClick` options. Each contiguous `href` run gets one transparent `<a>` hotspot child, kept stable across re-wrap (one per run) and pruned when the links change. Link glyphs render with the link color plus an underline.

- cd28e58: Streaming / typewriter rich text (战役一, PR C — "流式打字机"): re-laying out a growing styled document is now O(changed paragraph) instead of O(document).

  - **`@vectojs/core`**: `LayoutEngine.prepareRich` now memoizes per paragraph (mirroring the plain `prepare` memo), keyed by `fontSize` + text + a _value_-based run-length signature of the inline styles. A streaming caller that appends styled runs reuses every untouched leading paragraph by reference — even if it passes fresh style objects with the same values. The memo is invalidated when the font atlas changes.
  - **`@vectojs/ui`**: `RichText.appendSpans(spans)` and `Text.append(text)` for incremental streaming; both re-lay out through the paragraph memo.

- 7a702a8: Add a multi-line `TextArea` component (战役二).

  - **`@vectojs/ui`**: new `TextArea` — a multi-line field backed by a real, transparent `<textarea>` shadow node. The browser owns editing (keyboard, IME composition, selection, clipboard, undo, multi-line navigation); the canvas mirrors it, re-wrapping the value and drawing text, cross-line selection, and a blinking caret with vertical scroll-to-caret. Exposes a pure `wrapText(value, maxWidth, measure)` helper (offset-aware line wrapping with hard-newline + char-level breaking) and `lineOfOffset()` for caret mapping.
  - **`@vectojs/core`**: the a11y/automation shadow layer now supports `tag: 'textarea'` — `Scene.syncA11y` projects a `<textarea>`, sets its placeholder, syncs its value, and forwards its `input`/`change`/selection/IME events back to the entity (previously only `<input>` was wired).

- c1aebf2: Add touch / pointer-drag support.

  - `core`: `Scene` calls `setPointerCapture` on `pointerdown` and releases it on `pointerup`, so a drag keeps receiving `pointermove`/`pointerup` after the pointer leaves the node's box; interactive shadow nodes get `touch-action: none` so the browser doesn't claim touch drags (the canvas owns its gestures).
  - `ui`: `ScrollView` now scrolls by pointer-drag (touch & mouse), not just the wheel — content follows the finger 1:1 and clamps to the content bounds. The wheel/drag clamping is shared in one helper.

- Updated dependencies [c98d3e3]
- Updated dependencies [8faa813]
- Updated dependencies [668e503]
- Updated dependencies [382e34f]
- Updated dependencies [b5e2c76]
- Updated dependencies [90a4339]
- Updated dependencies [aa5e473]
- Updated dependencies [2a20b15]
- Updated dependencies [2512008]
- Updated dependencies [6ad07c7]
- Updated dependencies [cd28e58]
- Updated dependencies [7a702a8]
- Updated dependencies [c1aebf2]
  - @vectojs/core@0.6.0

## 0.2.3

### Patch Changes

- 9253e61: Memoize `measureText` with a bounded LRU cache (`(font, text) → width`).

  Native canvas `measureText` forces a layout/context switch on every call. Hot paths re-measure the same strings each frame — `wrapLines` (per-word candidates) and `Input` caret positioning (growing prefixes) — so a 1000-entry LRU keeps the working set hot while capping memory for dynamic text. Behavior is unchanged; repeated measurements are just served from cache.

- c1d428f: Add a scrollable viewport (`ScrollView`) with clipping + wheel scrolling.

  - `core`: `Entity.clipChildren` (Scene clips a node's children to its local box) and a forwarded `'wheel'` event from the shadow node (non-passive, so a scroll container can `preventDefault()` the page scroll).
  - `ui`: `ScrollView({ width, height })` — nests children in a clipped content layer, scrolls on wheel with a damped spring, and clamps to the content bounds. Unblocks scrollable docs/long-list pages built with VectoJS.

- 6f84f7f: `Toggle` now emits a `change` event, unifying the form-control event model.

  Previously a `Toggle` only invoked its `onChange` constructor callback, so
  external `on('change', …)` listeners never fired (its `role="switch"` shadow node
  is a `div`, which the Scene doesn't forward native changes for — unlike `Input`
  /`Checkbox`). Toggling now goes through a single `change` handler that drives both
  `on('change')` and `onChange`, matching the other form components.

- Updated dependencies [ac8b159]
- Updated dependencies [59a2b64]
- Updated dependencies [c1d428f]
- Updated dependencies [7f5e403]
- Updated dependencies [9d587db]
  - @vectojs/core@0.5.3

## 0.2.2

### Patch Changes

- 7c9e40c: Docs: rewrite READMEs for accurate positioning and honest, reproducible numbers.

  Removes the fabricated "React vs core" comparison table (1k/10k/100k → React
  "Crash" vs "60 FPS") and the misleading "60 FPS with 100,000+ entities" tagline.
  READMEs now describe VectoJS as a Zero-DOM canvas UI runtime with the a11y/agent
  moat, cite measured benchmark numbers, list the full component set, document the
  IME-capable `Input`, and state where the framework does and doesn't fit.

- 88c08c5: Route `Text` through the shared `LayoutEngine` instead of its own ad-hoc
  `wrapLines`. `Text` now uses the same `Intl.Segmenter` measurement path as
  `TextEntity`, with the cold/hot split: `setText` re-measures (cold), the new
  `setMaxWidth` re-wraps via the hot path only (no re-segmentation/re-measurement).
  Blank lines and explicit newlines are preserved. Public `measureText` /
  `wrapLines` / `fontSizePx` are unchanged and still exported.
- Updated dependencies [715693b]
- Updated dependencies [7c9e40c]
  - @vectojs/core@0.5.2

## 0.2.1

### Patch Changes

- 0362f14: IME / text-selection moat for the canvas `Input` (canvas-mirror approach).

  The real, transparent `<input>` shadow node already handles all native input
  (IME composition, selection, clipboard, undo); the canvas now mirrors it visually.

  - **core**: `IRenderer.clip(x, y, w, h)` (rect clip, implemented in `CanvasRenderer`).
    `Scene.syncA11y` forwards IME composition (`{ start, length } | null`), selection
    (`selectionStart`/`selectionEnd`), and new `focus`/`blur` events from text `<input>`
    shadow nodes; the `change` payload is extended accordingly.
  - **ui**: `Input` renders a blinking caret (when focused), a selection highlight, the
    IME composing segment (underlined), and scrolls horizontally to keep the caret in
    view for overflowing text. A human can now type CJK into a pure-canvas field; agents
    still drive it by role.

- Updated dependencies [1de96df]
- Updated dependencies [0362f14]
  - @vectojs/core@0.5.1

## 0.2.0

### Minor Changes

- 9abb2b5: Add six new component primitives, completing the layout/display and form-control set.

  - **Layout/display**: `Image` (`<img alt>` shadow node, placeholder until load),
    `Card` (rounded panel + optional border, optional `role="group"`), `Stack`
    (vertical/horizontal auto-layout with gap + cross-axis align).
  - **Form controls** (real shadow nodes, agent-/AT-operable by role): `Input`
    (`<input>` textbox, value flows back via the `change` event), `Checkbox`
    (`<input type=checkbox>`), `Toggle` (`role="switch"` with `aria-checked`).
  - Exposes `fontSizePx(font)` and fixes a sizing bug: component height now parses
    the `px` token from a CSS font shorthand instead of `parseFloat`, which wrongly
    returned the _weight_ for fonts like `'600 16px sans-serif'` (made buttons/links
    hundreds of px tall).

### Patch Changes

- Updated dependencies [9abb2b5]
  - @vectojs/core@0.5.0

## 0.1.4

### Patch Changes

- Updated dependencies [a888e97]
- Updated dependencies [f68ade4]
  - @vectojs/core@0.4.0

## 0.1.3

### Patch Changes

- Updated dependencies [42819e7]
- Updated dependencies [3eb0910]
  - @vectojs/core@0.3.0

## 0.1.2

### Patch Changes

- 6fe2997: Fix the published dependency on `@vectojs/core`.

  Previous releases (0.1.0, 0.1.1) shipped with `"@vectojs/core": "workspace:*"`
  in the published `package.json` — the workspace protocol was not rewritten at
  publish time, so `npm install @vectojs/ui` failed with `EUNSUPPORTEDPROTOCOL`.
  The dependency is now a real semver range (`^0.2.0`), which bun still links
  locally in the monorepo and changesets keeps in sync on future core releases.

## 0.1.1

### Patch Changes

- Updated dependencies [cd59328]
- Updated dependencies [cd59328]
- Updated dependencies [6463b61]
  - @vectojs/core@0.2.0

## 0.1.0

### Minor Changes

- e3b05d3: Add `@vectojs/ui` — high-level canvas UI components rendered to a `<canvas>`
  with an accessibility/automation shadow layer:

  - `Text` — multi-line text via native canvas measurement, projects a labelled
    `div`.
  - `Button` — rounded-rect button with hover state, projects a real
    `<button role="button" aria-label>`; `onClick` fires from both the canvas
    hit-test and the shadow button.
  - `Link` — underlined link text, projects a real `<a href>` (natively clickable
    and crawlable).

  Built on the new `Entity.getA11yAttributes()` hook so screen readers and
  automation agents can operate the canvas UI.
