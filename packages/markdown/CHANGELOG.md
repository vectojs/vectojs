# @vectojs/markdown

## 0.5.0

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

- c691773: Add `Markdown.createStream()` for frame-coalesced, backpressured token streams.

  The lifecycle-bound controller batches accepted chunks into at most one parse/layout commit per animation frame, supports optional fixed-rate grapheme pacing, final flush, `AbortSignal`, and deterministic destroy cleanup, while the existing `appendMarkdown()` API remains synchronous.

- 67e6544: Add default-off User Timing instrumentation for Scene render phases and Markdown parsing. Enable it per instance with `userTiming: true` or `setUserTiming(true)` to emit stable `vecto:scene:*` and `vecto:markdown:parse` marks and measures for browser traces and profiles.

### Patch Changes

- 0450640: `Markdown`: keep blockquote content within the configured width.

  Nested blocks now receive the width left after each blockquote indent, so wrapped text and nested blockquotes no longer overflow their containers.

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

## 0.4.0

### Minor Changes

- 6d75502: Stream markdown to the worker as an append delta instead of the whole document

  A streamed `appendMarkdown()` used to post the entire accumulated `rawMarkdown`
  on every chunk, so the structured clone charged to the caller's thread grew with
  the document: O(N) per chunk, O(N²) per stream. The worker now owns the source
  text alongside the raw list it already kept (keyed by instance + token version),
  and a steady-state request carries only `{ append, expectedLength }`.

  Measured on real hardware, per-append main-thread `postMessage` cost on Chrome
  drops from 4.08µs at 8KB / 34.54µs at 128KB / 219.68µs at 512KB to a flat
  2.07–2.50µs at every size. Whole-stream main-thread time saved: ~3ms at 32KB,
  ~68ms at 128KB, ~1.8s at 512KB (Firefox: ~3ms / ~30ms / ~680ms). The lex itself
  is unchanged — `marked` has no incremental lexer — but it runs off-thread,
  whereas the transfer did not.

  The caller tracks how much source the worker holds and sends the full text plus
  `oldRaws` whenever that is unknown: the first request, after `setContent()`, and
  after a local sync-fallback parse. The worker validates every delta against
  `expectedLength` and its cached token version, and answers `needResync` (dropping
  its cache entry) if either disagrees, so a lost or reordered request costs one
  round trip rather than corrupting the document. A first request now carries the
  text and the raws together instead of being answered with `needRaws` and sending
  the document a second time.

  No API change: `appendMarkdown()`, `setContent()`, and `destroy()` behave as
  before.

### Patch Changes

- f68446d: Discard an in-flight worker reply when `setContent()` replaces the document

  A worker request dispatched before `setContent()` was still applied after it. The
  reply's `matchLen` is relative to a token snapshot captured from the document
  being replaced, and its closure still holds that snapshot, so applying it rebuilt
  the tree from a document that no longer existed: `rawMarkdown` held the new text
  while `tokens` reverted to the old, and the next append then diffed against
  tokens the source never had.

  `setContent()` now drops any pending callbacks — as `destroy()` already did — and
  clears the in-flight flag. Both halves are required: the flag gates every
  dispatch, so dropping the callback alone would leave the next append waiting
  forever for a reply that can no longer arrive.

  Reachable from switching conversation threads mid-stream, or any
  `setContent()` while a chunk is outstanding.

## 0.3.0

### Minor Changes

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
