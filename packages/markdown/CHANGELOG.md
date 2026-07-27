# @vectojs/markdown

## 0.2.0

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

### Patch Changes

- b408036: Add `GlyphRasterAtlas`, a texture atlas of rasterized glyphs for grids that draw
  a bounded glyph set thousands of times per frame, plus an optional
  `IRenderer.drawImageRect` (9-argument `drawImage`) that `CanvasRenderer`
  implements and `SVGRenderer` deliberately omits.

  `CodeBlock` now blits its grid from a shared atlas where the renderer supports a
  source-rect draw, falling back to `fillText` otherwise. Measured 1.32-2.22x
  (Chrome) and 1.42-1.87x (Firefox) against the renderer's own font/fillStyle-cached
  `fillText` path.

  Named `GlyphRasterAtlas` because `@vectojs/layout` already exports a `GlyphAtlas`
  interface for vector path metrics, which the core barrel re-exports.

## 0.1.2

### Patch Changes

- 9d42b01: Make a streaming code block ~3x cheaper per chunk.

  Two changes, only the second of which mattered:

  `CodeBlock` is now reused in place during streaming (via the `setCode()` that
  already existed but the reconciler never called), instead of being destroyed and
  rebuilt on every chunk. An unclosed fenced block is the second most common shape an
  LLM streams, so this looked like the win — **measured, it changed nothing.**

  The actual cost was inside `buildLines`, which re-highlighted **every line** on
  every call. Streaming appends to the end, so all but the last line are
  byte-identical to the previous build; re-tokenizing them made an append O(N) and a
  whole stream O(N²). It now reuses the highlight of the unchanged line prefix.

  Measured over 300 appends to a growing block: **34.07ms → 11.55ms (2.95x)**,
  0.114ms → 0.038ms per append. The lexer's share of the remaining time rose from 7%
  to 23%, which is the cross-check that the removed work was real.

  The previous last line is deliberately not reused, since a chunk usually lands
  mid-line and changes it.

- 8b3c548: Stop re-deriving the token prefix the worker already computed.

  The worker calculates the raw-equal prefix length to decide which token tail to
  send, then `updateTokens` re-scanned every token's `raw` string on the main thread
  to compute the same number. It now takes the worker's value.

  Validated rather than trusted: a value outside either token array would make the
  prefix slice reuse entities that do not correspond to the new tokens, so an
  out-of-range hint falls back to scanning.

  Token counts are far below character counts, so this is a small saving — but it was
  duplicated work on every streamed chunk.

## 0.1.1

### Patch Changes

- 97e97bb: Complete the lifecycle-leak teardown on the `destroy()` path (follow-up to the `Entity.destroy()` recursion fix):

  - **MSDF worker slot**: `MSDFTextEntity.destroy()` now cancels its queued layout via a new static `LayoutWorkerManager.cancelLayoutForEntity(id)` that no-ops when no manager exists, instead of `getInstance().cancelLayout()` which resurrected the worker singleton (and threw in SSR, where `Worker` is undefined) purely to cancel.
  - **DOMPortalEntity observer/listeners on `scene.remove()`**: the `ResizeObserver` and DOM event listeners are now managed by `attachDOMBindings()` / `releaseDOMBindings()`. `scene.remove()` (and off-screen portal reconcile) releases them so a detached portal no longer leaks an observer that keeps its element alive and firing; the projection path re-attaches them idempotently if the portal is re-added, so remove→re-add still works.
  - **Streaming Markdown**: `setContent()` and `updateTokens()` now `destroy()` discarded blocks (freeing each block's subtree resources) instead of only detaching them, and a new `Markdown.destroy()` drops this instance's in-flight worker callbacks (each pinned the whole entity via its closure) before recursing the content subtree.
  - **ComputeParticleEntity**: no code change needed — the `Entity.destroy()` recursion already frees nested particle GPU buffers; added a regression test proving a nested particle subtree's buffers are all released.

- 7f71419: Stop re-sending the whole prior-token raw list to the Markdown worker on every
  streamed chunk. `dispatchAppend` posted `oldRaws` (the raw source of every token
  the caller already held) alongside the accumulated `text`, so each chunk shipped
  the document **twice** — an extra O(document) transfer + structured-clone per
  chunk over a stream.

  The worker now caches that raw list itself, keyed by the Markdown instance and
  its token version, so a steady-state chunk posts only the text. The version is
  bumped on every token-list mutation, so any change the worker didn't produce
  (`setContent`, a main-thread sync-fallback parse) invalidates the cache and the
  worker asks for one resync (`needRaws`) instead of diffing against stale raws —
  a wrong `matchLen` would corrupt the reconciled token list. A destroyed block
  tells the worker to drop its entry.

  `updateTokens` no longer rebuilds its token-index → child-entity-index map over
  every token per chunk: the prefix sum is maintained incrementally (only the
  changed suffix is recomputed), and the entity-destroy loop now starts at the
  match point instead of scanning from 0 and skipping.

  Real-HW (`benchmarks/markdown-stream-transfer`, Chrome 150 + Firefox 153):
  posted bytes over a 400-chunk stream drop from 9953 KB to 5002 KB (1.99×). The
  remaining growth is the `text` field itself, which cannot shrink while `marked`
  has no incremental lexer.

- 5af6dec: Place RTL Markdown list markers on the reading-start (right) side. `Markdown` always prepended the bullet/number as a leading span, so for a right-to-left item (Arabic, Hebrew) the directionally-neutral marker bidi-reordered to the visual **left** instead of the reading-start **right**. The list now detects each item's base direction (`BidiResolver.getBaseLevel`) and, for RTL items, appends the marker as a trailing span — `" •"` reorders to a visual `"• …"` and `" .N"` to `"N. …"`, both flush-right in reading order. LTR items keep the leading marker exactly as before. Verified on real Chrome 150 (bullet/number on the right for Arabic lists, still on the left for LTR).
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

- 63fc4b7: Two text-correctness fixes.

  **Text-default pictographs no longer count as double-width** (`@vectojs/text`). `PreparedContentGrid`'s `isWideCluster` treated every `Extended_Pictographic` code point as width-2, but `© ® ™ ☺ ✔ ❤` (and many others) are _text-default_ — width-1 unless an emoji variation selector (VS16) forces emoji presentation. This drifted the caret in the monospace content grid. A pictograph is now wide only when it carries VS16 or is `Emoji_Presentation` by default (and VS15 forces it narrow); flags, keycaps, and CJK are unaffected.

  **Inline `code` now renders (and measures) as monospace** (`@vectojs/layout`, `@vectojs/ui`, `@vectojs/markdown`). `TextStyle` gains an optional `fontFamily`, and `GlyphMeasurer.measure` gains an optional `fontFamily` argument, so a run in a different family lays out at its own metrics instead of the base font's. `RichText` honors it in both drawing (`nodeFont`) and measurement, and Markdown inline `codespan` now sets `fontFamily` to the theme's monospace stack — previously inline code was only tinted, rendered in the proportional prose font. Fenced `CodeBlock` was already monospace and is unchanged. Runs without `fontFamily` keep the component's base family (no behavior change for existing callers).

- 5eae419: Three streaming/Markdown text-correctness fixes:

  - **Streaming reshape froze word boundaries** (`LayoutEngine`): the incremental fast path re-segmented only the last cached word, so text streamed character-by-character kept spurious boundaries a one-shot shape never produces — `"3"→"."→"1"→"4"` became `["3", ".", "14"]` instead of `["3.14"]`, and decimals / URLs / abbreviations streamed live wrapped wrong. It now re-segments the whole trailing same-category (whitespace vs non-whitespace) run, which is the exact boundary the appended suffix cannot dissolve, so every streamed prefix now matches a from-scratch shape.
  - **`updateTokens` child-index desync** (`Markdown`): the token→child-entity index map (and the removal loop) skipped only `space` tokens, but a non-SVG raw `html` block (e.g. an HTML comment or bare `<div>`) and a fallback token without `text` also render no entity. A null-rendering token before the growing tail shifted every subsequent entity index by one, so the wrong entity was updated or destroyed — common in LLM Markdown. Introduced a `producesEntity()` predicate kept in lockstep with `renderToken`'s null returns and used by both the index map and the removal loop.
  - **Inline-math tokenizer ate currency** (`Markdown`): `$…$` matched greedily, so "costs $5 to $10" became a single math span. The tokenizer now requires the opening `$` to not be `$$` and to be followed by a non-space, non-digit, and the closing `$` to be preceded by a non-space and not followed by a digit (pandoc-style). Genuine `$x+1$` still tokenizes; "$5 to $10", "$9 each", and "$$" do not. Applied to both the main-thread and worker tokenizers (regenerated `MarkdownWorkerSource`).

## 0.1.0

### Minor Changes

- e2cad3e: Introduce `@vectojs/markdown` as a standalone package: the `Markdown` entity and
  `CodeBlock`, which parse Markdown with `marked` and render TeX math to SVG with
  MathJax, laid out using `@vectojs/ui` components. Extracted from `@vectojs/ui`
  so the heavy `marked` + `mathjax-full` dependencies are only pulled in by apps
  that actually render Markdown. Depends on `@vectojs/ui` and `@vectojs/core`.
