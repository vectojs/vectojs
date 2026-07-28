# @vectojs/layout

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
