# @vectojs/markdown

## 0.10.0

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

## 0.9.0

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

- 6b71a9f: Rebuild the code-block glyph atlas when the device pixel ratio changes, so code
  stops blurring after a browser zoom.

  `CodeBlock` blits its grid from a shared `GlyphRasterAtlas` whose slots are device
  pixels at a fixed ratio. That atlas was a module-level singleton capturing
  `devicePixelRatio` at first use, and `GlyphRasterAtlas.dpr` was `private readonly`
  with no rebuild path — so after a zoom the grid kept blitting a texture rasterized
  at the old ratio while the DPR-scaled context resampled it. Every other text entity
  re-rasterizes per frame, so **only code looked soft**, which is why it read as a
  font problem rather than a cache problem.

  Measured in real Firefox 153 on one live page, no reload: zooming 100% → 133% moved
  the renderer 1.579 → 2.068 while the atlas stayed at 1.579 (`blitScale` 1.31,
  `resets` 0); at 500% the renderer reached 4.286 for a `blitScale` of 2.71. Peak
  edge contrast inside the fenced block fell **171 → 139 → 73** across those three
  states while prose held 255.

  Atlases are now pooled **per ratio** rather than mutated, since a slot's device
  pixels are only meaningful at the ratio they were rasterized at. A zoom selects a
  different atlas and zooming back reuses the original instead of re-rasterizing; the
  pool is bounded to two entries and `destroy()`s on eviction, because each holds a
  2048² canvas (~16 MB). This also makes two scenes at _different_ effective ratios
  correct — `SceneOptions.maxDPR` lets one cap at 2 while another runs uncapped, and
  a single atlas would have thrashed between them every frame.

  The `Math.min(dpr, 3)` cap is gone. It existed because atlas area grows with dpr²,
  but it made correctness _impossible_ above it: this host's 500% zoom is 4.286, so a
  capped atlas is permanently resampled by 1.43x and no rebuild path helps. A code
  block's glyph set is bounded (one mono font, one size, a handful of theme colours),
  and the honest failure mode of an over-full atlas is `stats.resets` climbing, which
  was already instrumented and already documented as the signal to fall back to
  `fillText`. Measured at 4.286 with a real document: 0 resets.

  New API, both additive:

  - `IRenderer.pixelRatio` (optional, `CanvasRenderer` implements it) — device pixels
    per CSS pixel of the renderer's **backing store**. Read this rather than
    `window.devicePixelRatio` when rasterizing pixels to blit, since the two differ
    whenever a backend clamps. It deliberately reports the ratio the context is
    _currently_ scaled by rather than recomputing live: `devicePixelRatio` changes the
    instant a zoom lands, but the backing store is only reallocated when something
    calls `resize()`, and a live value would hand callers the _future_ ratio during
    that window — the same resampling defect inverted.
  - `GlyphRasterAtlas.pixelRatio` — the ratio its slots were rasterized at, so a
    caller can assert `renderer.pixelRatio / atlas.pixelRatio === 1`.

  Covered by a new both-engines gate, `packages/markdown/e2e/code-atlas-dpr.e2e.ts`,
  which drives three ratios on one live page without reloading and asserts both the
  mechanism (`blitScale === 1`) and the symptom (code contrast within 10% of its
  first-ratio value, with prose as a control arm). Each arm was confirmed to fail
  against the pre-fix behaviour independently — `blitScale` 1.3097, and contrast
  178.4 → 147.7 (-17.2%). Peak edge contrast is asserted rather than mean luminance
  gradient: mono glyphs are thinner and syntax-coloured, so the mean moved the _wrong
  way_ under a 2.71x mismatch (0.216 matched vs 0.251 mismatched) and would have
  "disproved" a real defect.

- 2e5d49b: Lex from the last stable block boundary instead of re-lexing the whole document
  on every streamed chunk.

  `marked` has no incremental lexing API, so the streaming path re-lexed the entire
  accumulated source per chunk, making a stream O(n²). `incrementalLex` now tracks
  the last **stable block boundary** — a blank line that appended text can no longer
  reach across — and lexes only the text after it, splicing the result onto the
  already-stable token prefix.

  Measured in `comparisons/stream-markdown-smd` on real Chrome 150 / Firefox 153,
  COOP+COEP isolated, median of 9 after 3 warmups, 32-char chunks. A 200-section
  document (25 070 chars, 784 chunks):

  |                  | before    | after           |
  | ---------------- | --------- | --------------- |
  | Chrome 150       | 419.6 ms  | 6.02 ms (69.8x) |
  | Firefox 153      | 440.2 ms  | 9.06 ms (48.6x) |
  | scaling exponent | 1.98      | 0.94 / 1.21     |
  | characters lexed | 9 847 040 | 63 806 (154x)   |

  The exponent is the substance: the streaming path is now linear rather than
  quadratic, so the improvement grows with document length (7.8x at 25 sections,
  69.8x at 200).

  Token output is unchanged. The contract is that a streamed lex is deeply identical
  to `marked.lexer()` of the same source at every intermediate length, enforced by a
  differential suite that streams a corpus one character at a time plus a seeded
  fuzzer over randomly assembled documents and chunkings.

  Two document shapes keep the previous cost by design, because appended text can
  retroactively change tokens already emitted: those containing a **link reference
  definition** (`marked` resolves reference links across the whole document after
  block-lexing) and those containing **display math** (`$$`, whose tokenizer spans
  blank lines and whose `start()` hook re-groups preceding paragraphs). Both degrade
  to whole-document lexing, which is correct and no slower than before.

## 0.8.0

### Minor Changes

- ae6d6ad: Render the three GFM constructs the lexer already produced but the renderer discarded.

  No parser work was involved — `marked` emits all three and `renderToken`/`collectSpans`
  simply had no case for them, so each failed in a way that looked like plain output
  rather than a missing feature:

  - **Strikethrough.** `~~gone~~` lexes to a `del` token, which fell through to the
    default arm and pushed its text unstyled, so the content rendered without a line.
    Nested emphasis and a struck link (`~~[x](url)~~`, a `del` wrapping a `link`) both
    keep their own styling.
  - **Task lists.** `- [ ] todo` carries `task`/`checked` on the item; nothing read
    them, so no box was drawn. A task item now shows ☐/☑ in place of the bullet
    (matching GitHub, which suppresses the bullet for a task list) and after the
    number in an ordered list. The box follows the same reading-direction rule as the
    bullet, so an RTL item shows it on the visual right, and a loose list renders
    identically to a tight one — `marked` puts its `checkbox` token at a different
    depth for each, which is why `item.task` is the source rather than that token.
  - **Table alignment.** `| :--- | :---: | ---: |` resolves to `align` on the token
    and was dropped, so every column rendered left-aligned. It is now forwarded to
    `@vectojs/ui`'s new `TableOptions.align`. A streamed table rebuilds rather than
    reusing when alignment changes, which is reachable mid-stream: `| --- | ---`
    already lexes to a table, and a colon arriving in the next chunk re-lexes the same
    table with new alignment.

- 00d0311: Parse YAML front matter off the document instead of rendering it as content.

  `marked` has no notion of front matter, so a document opening `---\ntitle: A\n---` lexed as a thematic break followed by a **setext heading** — the closing `---` underlines the keys. The document therefore painted a horizontal rule plus a 28px bold heading made of its own metadata. It is now stripped ahead of the lexer and exposed instead:

  - `md.frontMatter` — the block's verbatim contents, unparsed.
  - `md.frontMatterFields` — top-level scalar `key: value` pairs. A narrow convenience, not YAML: indented lines are skipped, so nested mappings and sequences do not leak out as top-level keys.
  - `scanFrontMatter(text, complete)` and `parseFrontMatterFields(raw)` are exported for use on raw text.

  Recognition is deliberately conservative, because a false positive silently deletes the top of a document. A leading `---` is front matter only when the next line is a YAML mapping entry (`key: value`, whitespace after the colon as YAML requires) and a closing `---` or `...` follows. So `---\n\n# Title`, `---\n# Title\n---`, `----\nkey: v\n----` and `---\n- a\n---` all keep rendering a thematic break as before.

  Streaming is handled: a chunk that lands inside an unclosed block is held rather than lexed, so the document does not paint a rule that the closing delimiter then has to tear down. A block still open when the stream closes is released as content — which is what `marked` produced all along — and the hold is bounded, so a thematic break at the top of a long document cannot stall it.

## 0.7.0

### Minor Changes

- 62cd231: Render `$$...$$` as display math, and give every math SVG an explicit colour.

  There was no block-level math tokenizer: only an inline `$...$` rule, which
  deliberately refuses `$$` so currency ("$5 to $10") is not mistaken for a
  formula. With no block rule, marked's text tokenizer consumed the leading `$`,
  the inline rule matched the _inner_ `$...$` pair, and the outer two dollars
  survived as literal text — so `$$x$$` rendered the formula with a stray `$`
  painted on each side. A `blockMath` block extension now consumes the whole run,
  registered identically in `Markdown.ts` and `MarkdownWorker.ts`.

  Separately, MathJax paints glyphs with `fill="currentColor"`, and this package
  base64s the SVG into a `data:` URI. A data URI is an isolated document with no
  CSS inheritance, so `currentColor` fell back to its initial value — black —
  which made every formula invisible against this package's own dark default
  theme. The resolved colour is now set on the SVG root, so `currentColor`
  resolves inside that document: display math takes `theme.textColor`, and inline
  math inherits the colour of the run it sits in, so `$x$` in a heading or
  blockquote matches the prose around it. The colour is part of the conversion
  cache key, since it is baked into the cached bytes.

## 0.6.0

### Minor Changes

- a750002: Typeset inline `$...$` math instead of showing its TeX source.

  Inline math previously rendered as gold (`#fcd34d`) source text with the `$`
  delimiters visible, because `collectSpans` pushed `token.raw` and never called
  MathJax — `ensureMathJax()` was only reached from the fenced-block arm, so a
  document whose only math was inline never even started the lazy load. It now
  reserves a real inline box via `StyledSpan.object` (added in `@vectojs/layout`
  1.1.0), carrying the TeX source as the box's accessible name.

  Also fixes a pre-existing mis-sizing of **block** math. The `ex`-to-px
  conversion was a hardcoded `ex * 8`, which is exact only near a 18.1px font
  size — so a block formula was ~13% oversized at this package's own 16px
  default, +51% at 12px, and −43% at 32px. It is now
  `ex * fontSize * 0.4421`, resolved against the size of the run the formula
  actually sits in, so `$x$` in a heading scales with the heading.

- b2f440e: add `incompleteMode` and `onStable` streaming options

  `createStream()` accepts `incompleteMode: 'literal' | 'optimistic'`. The default
  `'literal'` is unchanged from every prior release: trailing unclosed inline
  syntax renders as the plain text `marked` produces for it. `'optimistic'` guesses
  that the trailing paragraph's last unclosed strong/emphasis/inline-code construct
  will close and renders it with that formatting immediately, hiding the syntax
  characters; an unclosed link shows its label as plain, non-clickable text because
  no URL is known yet. The guess is display-only, never touches `Markdown.tokens`,
  applies only to the document's last paragraph while the stream is open, and is
  unwound on `close()` — so a literal and an optimistic stream of the same source
  end at an identical document.

  `createStream()` also accepts `onStable`, which fires exactly once after a
  successful `close()` with a snapshot of the top-level block entities. It is not
  fired by `flush()`, `abort()`, or `destroy()`.

  `close()` now resolves only after the final chunk's parse has actually been
  applied. Previously it could resolve while the last chunk was still being lexed
  in the worker, so the rendered document did not yet reflect everything written.

- e68a69c: Load MathJax on demand instead of at module scope.

  The six `mathjax-full` imports and the MathJax document construction were
  top-level, so every consumer paid them whether or not any document contained a
  formula. Measured on a browser bundle of a consumer that imports `Markdown` and
  renders only prose: **2,157,295 bytes raw / 725,012 gzipped, down to 339,767 /
  106,095** — MathJax was 85% of the bundle. Startup also drops roughly 150 ms of
  module evaluation. Realising the size win requires code splitting in the
  consumer's bundler.

  New exports `preloadMathJax()` and `isMathJaxReady()`.

  **Behaviour change:** the first formula on a page can no longer be typeset
  synchronously. It renders as a code block of its TeX source — the state an
  unclosed fence already used — and is replaced when the module resolves; later
  formulas are synchronous. While streaming this is hidden by prefetching on the
  opening fence, and `await close()` / `onStable` now wait for a pending load so a
  final document is never handed an untypeset formula. Call `await preloadMathJax()`
  before constructing to keep the first formula synchronous.

### Patch Changes

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

- 5a5a35e: Reuse a streamed blockquote by updating its tail child in place.

  A blockquote renders a subtree — an accent border plus one wrapper per inner
  block — so unlike paragraph, code, and heading it has no single mutator to call.
  Reuse now descends to the last inner block and dispatches to the existing
  `setSpans`/`setCode` paths, so a quote streamed line by line no longer destroys
  and rebuilds every inner block and its border on each chunk.

  The fast path is deliberately narrow: it applies only when the inner block count
  is unchanged, every earlier inner block is byte-identical, the tail block kept its
  type, and that tail is a `paragraph`, `heading`, or `code`. A nested heading
  carries the same depth guard as the top-level path, since `setSpans` cannot change
  `font`. Anything else falls back to the existing rebuild, and every rejection path
  leaves the entity untouched. Wrapper, inner-stack, border, and container boxes are
  propagated by hand so a reused quote stays geometrically identical to a rebuilt
  one.

  Measured on real hardware (`benchmarks/markdown-stream-phases`, new `blockquote`
  shape, two runs per arm): reconcile fell from 52.7/48.8ms to 21.4/23.2ms in Chrome
  and 33.0ms to 15.3ms in Firefox. Total append+render time fell 31% (Chrome) and
  27% (Firefox) — larger than the heading case, because a rebuild here discarded a
  whole subtree.

- 5d3de06: Update a streamed heading in place instead of rebuilding it.

  A heading renders to a `RichText` through the same `renderInlineToRichText` a
  paragraph uses, so `setSpans` was always available — the reconciler dispatched on
  the literal string `'paragraph'` and so destroyed and rebuilt the heading entity on
  every chunk, re-shaping its text and forcing a full `Stack.layout()`.

  Reuse is guarded on unchanged heading depth: `RichText.setSpans` replaces the runs
  but does not touch `font`, which is constructor-only, and a heading's font size is
  derived from its depth. Streaming `#` then `# T` lexes to `## T`, moving the same
  token index from depth 1 to depth 2, so that case still rebuilds.

  Measured on real hardware (`benchmarks/markdown-stream-phases`, new `headings`
  shape, two runs per arm): reconcile time for a word-at-a-time heading fell from
  21.2/21.0ms to 11.1/10.7ms in Chrome and 12.2ms to 9.2ms in Firefox. Behaviour is
  unchanged; this is purely a reuse path.

- 0e4a423: Reuse a streamed image paragraph instead of rebuilding it, and stop dropping an
  image that arrives after its text.

  A paragraph containing an image renders as a `Stack` of alternating text runs and
  `Image`s rather than a single `RichText`, so it had no `setSpans` and fell through
  the in-place reuse path to a full rebuild — re-creating the `Image` on every
  chunk. The trailing text run is now mutated in place, and a run arriving after the
  image is appended. Measured on a growing figure-plus-caption stream, reconcile
  time drops 65% in Chrome and 70% in Firefox (total 31% in both).

  Also fixes a pre-existing correctness bug found by that work: the in-place branch
  dispatched on the _entity_ having `setSpans` without asking whether the new token
  still renders as one `RichText`, so a plain paragraph that gained its first image
  kept its `RichText` and was handed spans that omit the image entirely — the
  picture was silently dropped. Streaming `Figure: ` then `![a](u.png)` produced a
  bare text run where a one-shot parse gives a `Stack` with the image.

- 79e42d3: Reuse a streamed list's `Stack` instead of rebuilding every item.

  A `list` token carries **every** item, so a list streamed to N items rebuilt
  1+2+…+N `RichText` instances — Θ(N²). Measured before this change, a 32-item
  list cost 528 constructions against 32 for the same list built once. The
  reconciler now appends new items and rewrites only a growing tail item in place,
  guarded so any state a stream cannot produce (a shrinking list, an edit to a
  retained item, a tight→loose transition, a change of `ordered`/`start`) falls
  back to the existing rebuild.

  Real Chrome and Firefox, median of 7 trials, two runs per arm: reconcile for a
  growing list **70.7 → 20.8 ms (Chrome, −71%)** and **39.3 → 12.0 ms (Firefox,
  −66%)**, with total append+render **−37%** / **−17%**. The `mixed` shape also
  improves −31% / −28%, because a list followed by more prose is a trailing token
  that used to be rebuilt on every subsequent chunk.

  Also fixes a dead indent in the list renderer: `itemRt.x = 12` was overwritten by
  `Stack`'s append fast path (which assigns `x = 0` for a vertical stack and treats
  `x`/`y` as layout-controlled), so list items were never indented — while
  `maxWidth` still reserved 24px for that indent, shrinking the wrap width for no
  reason. Items now use the full available width. A list nested in a blockquote is
  still indented by the quote's own wrapper.

- 9233db0: Defer TeX math conversion until the fence closes, and cache converted formulas.

  `marked` lexes an unterminated fenced block as a complete `code` token as soon as
  it reads the info string, so a math formula streamed a few characters at a time
  arrived as a long run of whole tokens — nearly all of them syntactically invalid
  TeX. Every one of them ran MathJax, the most expensive call in this package, and
  each result was an error glyph immediately replaced by the next chunk.

  A math fence now renders as an ordinary `CodeBlock` showing the TeX source while
  it is open, and typesets on the chunk that closes it. As a `CodeBlock` it also
  picks up the existing `setCode` in-place update, so the growing source costs one
  mutator call per chunk instead of an entity rebuild.

  Converted formulas are additionally memoized in a bounded process-wide cache, so a
  repeated formula converts once — including the common case of a closed fence whose
  `raw` grows by the newline that follows it.

  Measured on the new `math` shape of `benchmarks/markdown-stream-phases` (a formula
  streamed in six chunks, a fresh formula per cycle so the cache cannot flatter the
  result), median of 7 trials, two runs per arm on real hardware:

  | Engine  |       reconcile |            total |
  | ------- | --------------: | ---------------: |
  | Chrome  | 77.0ms → 12.8ms | 158.5ms → 85.2ms |
  | Firefox | 91.5ms → 11.9ms | 173.3ms → 88.8ms |

  MathJax invocations over 36 streamed chunks containing three distinct formulas
  drop from 18 to 3.

  Also fixes a latent bug on the same path: the formula `Image` decodes its SVG
  asynchronously and had no `onLoad` handler, so under an `onDemand` scene — which
  repaints only when marked dirty — a formula could stay a blank placeholder
  indefinitely.

- 0f2852c: Repaint a paragraph image whenever its bitmap settles, not only when the bitmap
  reports a usable intrinsic size.

  `paragraphImage`'s `onLoad` called `scene.markDirty()` from inside a
  `naturalWidth && naturalHeight` check, so a source that loads successfully while
  reporting a zero dimension left the scene unnotified. An `onDemand` scene
  repaints only when marked, so nothing that changed at decode time was drawn. The
  display-math sibling already called it unconditionally, with a comment naming
  this exact hazard — the two call sites disagreed, and this aligns them.

  The trigger was identified by measurement rather than assumption. An
  `<svg width="0" height="0">` is the one shape that fires `onload` with
  `naturalWidth === 0` on both Chromium and Firefox. A dimensionless SVG is not:
  no `width`/`height`, `viewBox`-only, and `width="100%"` all fall back to the CSS
  default 300x150 and pass the check. A cross-origin raster is not either. A broken
  source reports zero but settles as `error`, so the callback never runs.

  Sizing behaviour is unchanged: a bitmap with a usable intrinsic size still
  corrects the box, and a zero-dimension bitmap still keeps its initial estimate.
  Covered by a new real-browser gate, `e2e/paragraph-image-repaint.e2e.ts`.

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
