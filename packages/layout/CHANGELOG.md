# @vectojs/layout

## 0.5.0

### Minor Changes

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

- 566f9d0: Lay out MSDF text on the main thread when the layout worker is unavailable or fails, instead of leaving it permanently unrendered.

  `MSDFTextEntity.render()` returns early while its `layoutResult` is null, and the only thing that ever set it was a `LayoutWorkerManager` callback. Those callbacks were discarded whenever the worker failed and dropped outright when no worker could be created, so text stayed invisible forever while its box, hit-testing, and DOM content projection all still reported success.

  A Content-Security-Policy that blocks `blob:` workers is the realistic trigger. Measured on Chromium and Firefox: `new Worker(blob:…)` does not throw under `worker-src 'none'`, a `script-src` without `blob:`, or `default-src 'self'` — it constructs and then fires `onerror`, so a CSP was indistinguishable from a crash except that it never stopped happening. Six layout requests spawned six Workers and delivered zero layouts.

  - The wrapping algorithm moved into a new exported `computeMSDFLayout(request, font)`, which the worker and the main thread now both call, so fallback geometry is identical rather than merely similar.
  - A failed or unavailable worker completes its queued requests synchronously.
  - Font metrics are retained per font id, so a fallback still works for a caller that passed `fontData` only on the first request.
  - Worker recreation is capped at two consecutive failures, after which layout stays on the main thread.
  - `new Worker` throwing no longer escapes `queueLayout` into `new MSDFTextEntity(...)`.

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

### Patch Changes

- Updated dependencies [ca20e66]
  - @vectojs/text@0.3.0

## 0.4.0

### Minor Changes

- dcb8a75: Expose cache statistics and per-glyph atlas misses.

  `LayoutEngine.cacheStats()` reports hits, misses, evictions, size, capacity and
  hit rate for the word, grapheme, paragraph and rich-paragraph caches;
  `resetCacheStats()` zeroes the tallies without discarding entries. `hitRate` is
  `null` until a cache has been consulted, because "never used" and "used and
  always missed" are different diagnoses.

  These caches are the difference between O(appended) and O(document) on a
  streaming paragraph, and there was previously no way to tell whether one was
  working. A key that varies by accident turns every lookup into a miss and the
  memo into pure overhead, with no symptom other than being slow.

  `PreparedGlyph.atlasMiss` records which glyph the atlas lacked. The engine already
  computed this to set the paragraph's `fallbackToCanvas` flag and then discarded
  it, so "some glyph in this paragraph fell back" was the finest granularity
  available — not enough to find the character responsible. Set on all three shaping
  paths (plain, rich, streaming fast path), and consistently excludes whitespace,
  matching how the paragraph flag already treats it.

## 0.3.0

### Minor Changes

- 48bc2ee: Add `LayoutEngine.measurePrepared(prepared)` — line count + total height at the
  engine's current `maxWidth` without positioning a single glyph or allocating a
  `LayoutNode`.

  `layoutPrepared()` exists to produce positioned glyphs, because selection
  geometry and the a11y projection need them. But a caller that only wants "how
  tall is this at this width" — a virtualized list measuring rows, a resize pass,
  an autosizing container — was paying the full O(glyphs) walk plus one allocation
  per glyph for data it discards. `measurePrepared()` walks the prepared _word_
  widths instead (O(words), zero allocation), reusing the same greedy wrap
  decisions, and falls back to per-glyph stepping only for a word wider than the
  measure (which must break mid-word).

  Measured real-HW (Chrome 150 / Firefox 153, 500 prose blocks × 4 widths):
  **30.71ms → 0.92ms (33×) in Chrome, 25.38ms → 4.02ms (6×) in Firefox.**

  Found by benchmarking against `@chenglou/pretext`, whose hot path is
  segment-level for exactly this reason — see the new `comparisons/` directory.

## 0.2.0

### Minor Changes

- c5c720a: Fix the zero-GC buffer layout path dropping BiDi reordering and the mixed-size
  baseline. `LayoutEngine.layoutPreparedIntoBuffer` (the per-frame path for large
  dynamic scenes) wrote glyphs in **logical** order at a single paragraph
  `fontSize`, so RTL text came out reversed and left-aligned, and mixed-size inline
  runs were positioned at the raw line top instead of a shared baseline — both
  already correct in the allocating `layoutPrepared`.

  The buffer path now mirrors it: per-line slots are reordered to visual order
  (UAX #9 L2) with the whole line flushed right for an RTL paragraph, and each
  glyph keeps its own size as `height` with a `(lineMax - size) * 0.8` baseline
  offset. A `levels` array on `LayoutResultBuffer` records each glyph's resolved
  embedding level (so consumers can tell direction per glyph). A pure-LTR line —
  the common hot path — skips the reorder entirely and stays allocation-free.

  `BidiResolver.reorderSegments(str, levels, baseLevel)` is new: it exposes the L2
  reversal segments so a caller holding parallel typed arrays can apply the same
  permutation in place without allocating a node per glyph. `reorderVisual` now
  delegates to it (behavior unchanged).

- c0bed6a: Add justify alignment and soft-hyphen breaking to the MSDF text path, reaching parity with `TextEntity`.

  - `LayoutWorker` gains a `textAlign: 'left' | 'justify'` request field. `'justify'` stretches every soft-wrapped line flush to `maxWidth` — widening inter-word spaces, or distributing slack between glyphs on a space-less CJK line — while paragraph-final and newline-ended lines stay ragged (matching `LayoutEngine`).
  - `LayoutWorker` now honors soft hyphens (U+00AD) as break opportunities: when a word overflows, it breaks at the last soft hyphen that still fits and emits a visible `-` glyph, instead of moving the whole word down.
  - `MSDFTextEntity` gains `setTextAlign('left' | 'justify')` (and a `textAlign` constructor option) plus `setHyphenator(fn | null)`. The hyphenator runs on the main thread (a function can't be structure-cloned into the layout worker), inserting U+00AD into the string sent to layout; the original text is preserved for accessibility / content projection.

- eaf9ecc: Right-align RTL paragraphs. The layout engine packed glyphs from the left and reordered within bidi runs, but never aligned the line as a whole — so Arabic/Hebrew paragraphs sat flush-left instead of flush-right (confirmed identical on real Chrome and Firefox, since canvas layout is engine-driven). `commitLine` now computes a whole-line shift when the paragraph base level is RTL and a finite wrap width is set, so each visual line ends flush at the wrap edge, per line, independently. LTR text, justified text, unbounded-width text, and exclusion-flow lines are unchanged (the last is left for a dedicated follow-up).
- 63fc4b7: Two text-correctness fixes.

  **Text-default pictographs no longer count as double-width** (`@vectojs/text`). `PreparedContentGrid`'s `isWideCluster` treated every `Extended_Pictographic` code point as width-2, but `© ® ™ ☺ ✔ ❤` (and many others) are _text-default_ — width-1 unless an emoji variation selector (VS16) forces emoji presentation. This drifted the caret in the monospace content grid. A pictograph is now wide only when it carries VS16 or is `Emoji_Presentation` by default (and VS15 forces it narrow); flags, keycaps, and CJK are unaffected.

  **Inline `code` now renders (and measures) as monospace** (`@vectojs/layout`, `@vectojs/ui`, `@vectojs/markdown`). `TextStyle` gains an optional `fontFamily`, and `GlyphMeasurer.measure` gains an optional `fontFamily` argument, so a run in a different family lays out at its own metrics instead of the base font's. `RichText` honors it in both drawing (`nodeFont`) and measurement, and Markdown inline `codespan` now sets `fontFamily` to the theme's monospace stack — previously inline code was only tinted, rendered in the proportional prose font. Fenced `CodeBlock` was already monospace and is unchanged. Runs without `fontFamily` keep the component's base family (no behavior change for existing callers).

### Patch Changes

- 04a1c6f: Add an incremental suffix-only shaping fast path to `LayoutEngine.prepareRich` for the streaming case: when a single simple-script paragraph (no RTL/Arabic/combining/emoji-sequence — see the new exported `isComplexScript`) grows by appending, its already-shaped prefix words are reused and only the new suffix is segmented/measured, instead of re-shaping the whole paragraph each call. This turns a growing paragraph's per-chunk shaping cost from O(length) into O(appended). Complex-script and multi-paragraph text fall through to the unchanged full shaper, so RTL/BiDi/Arabic output is byte-for-byte identical. Note: benefits pathological single huge paragraphs; realistic bounded-paragraph documents (each block a separate RichText) see little change since their per-block reshape is already small.
- 26b9bdf: Make `LayoutWorkerManager` (and therefore `MSDFTextEntity`) SSR-safe. `createWorker` had no environment guard, so constructing an `MSDFTextEntity` where `Worker`/`Blob`/`URL` are undefined (server-side rendering, non-DOM) threw — contradicting the "SSR-safe" contract the Markdown worker path already honored with its `typeof Worker` guard. `createWorker` now returns `null` in those environments, `ensureWorker` propagates it, and `queueLayout` no-ops (dropping the pending callback rather than retaining it) when no worker can be created. Layout resolves normally once the entity is used in a real browser, where a fresh `queueLayout` creates the worker.
- 97e97bb: Complete the lifecycle-leak teardown on the `destroy()` path (follow-up to the `Entity.destroy()` recursion fix):

  - **MSDF worker slot**: `MSDFTextEntity.destroy()` now cancels its queued layout via a new static `LayoutWorkerManager.cancelLayoutForEntity(id)` that no-ops when no manager exists, instead of `getInstance().cancelLayout()` which resurrected the worker singleton (and threw in SSR, where `Worker` is undefined) purely to cancel.
  - **DOMPortalEntity observer/listeners on `scene.remove()`**: the `ResizeObserver` and DOM event listeners are now managed by `attachDOMBindings()` / `releaseDOMBindings()`. `scene.remove()` (and off-screen portal reconcile) releases them so a detached portal no longer leaks an observer that keeps its element alive and firing; the projection path re-attaches them idempotently if the portal is re-added, so remove→re-add still works.
  - **Streaming Markdown**: `setContent()` and `updateTokens()` now `destroy()` discarded blocks (freeing each block's subtree resources) instead of only detaching them, and a new `Markdown.destroy()` drops this instance's in-flight worker callbacks (each pinned the whole entity via its closure) before recursing the content subtree.
  - **ComputeParticleEntity**: no code change needed — the `Entity.destroy()` recursion already frees nested particle GPU buffers; added a regression test proving a nested particle subtree's buffers are all released.

- 539700d: Fix four text-rendering defects found by verifying the suspected-issues list
  (a fifth turned out to be a false positive):

  - **MSDF missing glyphs collapsed the line** (`@vectojs/text`). A codepoint absent
    from the atlas (e.g. CJK in a Latin font) advanced the pen by zero, pulling
    every following glyph left and under-reporting `width`. It now advances by a
    substitute (the font's own space advance, else `.notdef`, else 0.5em) so the
    rest of the line stays put.
  - **MSDF combining marks took a full advance** (`@vectojs/text`). A nonspacing
    mark (category Mn) must not move the pen — it stacks on its base glyph — but a
    nonzero atlas advance was applied, rendering `é` (e + U+0301) as two glyphs side
    by side. Marks are now clamped to zero advance (and a _missing_ mark reserves no
    substitute advance either).
  - **CRLF `\r` was laid out as a glyph** (`@vectojs/layout`). Splitting the source
    on `'\n'` left the `\r` at the end of each paragraph, where it was shaped into a
    real node — a visible tofu box that also inflated the line width and shifted
    selection. All line-ending forms (`\r\n`, `\n`, lone `\r`) now end a paragraph
    and are excluded from shaping, while `sourceIndex` still indexes the original
    text (a CRLF break correctly accounts for both characters).
  - **RTL + justify was flush on only one edge** (`@vectojs/layout`). A justified RTL
    line skips the whole-line flush-right shift, but its logical trailing space (L1-reset
    to the base level) lands at the visual left and kept its width, so content began a
    space-width inside the measure. Leading visual whitespace is now collapsed, making
    justified RTL lines flush on both edges; LTR justify and non-justified RTL are
    unchanged.
  - **Unterminated quotes swallowed the rest of a code line** (`@vectojs/markdown`).
    `highlightLine` colored from any opening quote to end-of-line even when it never
    closed, so a Rust lifetime (`&'a str`) or a stray apostrophe turned the remainder
    green. A quote is now a string delimiter only when it closes on the same line.

- 5eae419: Three streaming/Markdown text-correctness fixes:

  - **Streaming reshape froze word boundaries** (`LayoutEngine`): the incremental fast path re-segmented only the last cached word, so text streamed character-by-character kept spurious boundaries a one-shot shape never produces — `"3"→"."→"1"→"4"` became `["3", ".", "14"]` instead of `["3.14"]`, and decimals / URLs / abbreviations streamed live wrapped wrong. It now re-segments the whole trailing same-category (whitespace vs non-whitespace) run, which is the exact boundary the appended suffix cannot dissolve, so every streamed prefix now matches a from-scratch shape.
  - **`updateTokens` child-index desync** (`Markdown`): the token→child-entity index map (and the removal loop) skipped only `space` tokens, but a non-SVG raw `html` block (e.g. an HTML comment or bare `<div>`) and a fallback token without `text` also render no entity. A null-rendering token before the growing tail shifted every subsequent entity index by one, so the wrong entity was updated or destroyed — common in LLM Markdown. Introduced a `producesEntity()` predicate kept in lockstep with `renderToken`'s null returns and used by both the index map and the removal loop.
  - **Inline-math tokenizer ate currency** (`Markdown`): `$…$` matched greedily, so "costs $5 to $10" became a single math span. The tokenizer now requires the opening `$` to not be `$$` and to be followed by a non-space, non-digit, and the closing `$` to be preceded by a non-space and not followed by a digit (pandoc-style). Genuine `$x+1$` still tokenizes; "$5 to $10", "$9 each", and "$$" do not. Applied to both the main-thread and worker tokenizers (regenerated `MarkdownWorkerSource`).

- Updated dependencies [2bebe0c]
- Updated dependencies [c5c720a]
- Updated dependencies [539700d]
- Updated dependencies [63fc4b7]
  - @vectojs/text@0.2.0

## 0.1.0

### Minor Changes

- 3a623c1: Introduce `@vectojs/layout` as a standalone package: the `LayoutEngine`
  (line breaking, BiDi-aware inline layout, exclusion flow), `LayoutWorkerManager`
  (off-main-thread layout via an embedded worker), and glyph measurement helpers.
  Extracted from `@vectojs/core`; depends only on `@vectojs/text` for shaping
  primitives. `@vectojs/core` re-exports everything here (and keeps the
  `@vectojs/core/layout` subpath) for backward compatibility.

### Patch Changes

- Updated dependencies [3a623c1]
  - @vectojs/text@0.1.0
