---
title: "04 — Streaming Markdown — Incremental Reconcile"
description: "Why any prefix can be incomplete syntax, the committed-prefix lexer, worker delta protocol, token→entity reconcile with in-place mutators, the O(C·N²) and wrapper-instanceof traps, and the safe way to add a new extension."
order: 24
---

# 04 — Streaming Markdown — Incremental Reconcile

LLM streams are **append-only** and **token-grained** (~4 chars per chunk). VectoJS must show a readable document after every chunk — no blank until `close()`. The obvious strategy — re-lex the whole accumulated source and rebuild the entity tree each time — is `O(document)` per chunk, therefore `O(N²)` over a stream. This chapter is the mechanism that makes it `O(unstable tail)` instead, and the traps that made each half silently not work.

## Why any prefix is incomplete syntax

`marked` is a **one-shot** lexer. It assumes the whole source is present. Every Markdown construct whose terminator hasn't arrived yet changes what the prefix means once it does:

| prefix on screen                   | what it looks like now                                               | what the next chunk can make it                                                                                           |
| ---------------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `## Heading` without trailing `\n` | `heading(depth:2)`                                                   | `heading(depth:1)` if a leading `#` is still in flight (`#` → `##`) — depth is not stable until the line ends             |
| `**bold`                           | `text("**bold")` + literal `**`                                      | `strong("bold")` once the closing `**` arrives                                                                            |
| `[label](https://ex`               | `text("[label](https://ex")` + autolinked bare URL                   | `link(label → https://example.com)` — the URL is not even a complete href yet                                             |
| ` ```js\nconst a=1 `               | `code(lang:js, text:"const a=1")` with unclosed fence                | still a `code` — but the fence may also become ` ```math ` and then typeset as display math                               |
| `\| a \| b \|\n\| --- \| ---`      | `table(header:[a,b], rows:[])` — delimiter row, zero body rows       | `table(rows:[[…]])` — `marked` materializes a partial row as a full row of **empty cells** then fills them one at a time  |
| `$$\nx`                            | `paragraph("$$\\nx")` (the extension clips marked's paragraph input) | `blockMath("x")` once `$$` closes — plus marked's `start()` clip can **retroactively merge** two prior `paragraph` tokens |

Without a streaming-aware layer, every one of these flips would be a teardown of rendered entities. The layer has two halves — lex and reconcile — and the defects lived at their seam.

## Architecture — lex · transfer · reconcile

```text
chunk ──► consumeFrontMatter ──► dispatchAppend ──► MarkdownWorker (off-thread)
                │                        │                    │
                │ rawMarkdown            │ postMessage         │ incrementalLex
                │ (body only)            │ {append,expectedLen}│ lexAppend / lexFull
                │                        │  or {text,oldRaws}  │ findStableCut + verify
                │                        │                    │
                ◄────── matchLen + tail ─┘                    │
                              │                               │
                     updateTokens(matchLen, tail)  ◄──────────┘
                              │
              ┌───────────────┼───────────────────┐
              │ prefix [0,matchLen) kept          │  entitiesReused++
              │ tail: reuse / rebuild / mutate    │  inPlaceUpdates vs entitiesRebuilt
              └───────────────┼───────────────────┘
                              │
                    content Stack + width/height republish
                              │
                    Scene.markDirty() + notifyLayoutUpdated()
```text

Three modules own the three phases:

- **Lex** — `packages/markdown/src/incrementalLex.ts:446` `lexFull` / `packages/markdown/src/incrementalLex.ts:477` `lexAppend` plus `MarkdownWorker.ts:230` `self.onmessage`. The cache is `IncrementalLexCache` (`incrementalLex.ts:207`): `source`, `tail = source.slice(stableOffset)`, `tokens`, `stableCount`, `stableOffset`, `degraded`.
- **Transfer** — `Markdown.ts:2244` `dispatchAppend` and `MarkdownWorker.ts:345` diff. Steady state sends `{append, expectedLength}` (delta); first/resync/recovery sends `{text, oldRaws}` (full). The worker diff computes `matchLen` and returns `tail = tokens.slice(matchLen)`.
- **Reconcile** — `Markdown.ts:3674` `updateTokens(oldTokens → newTokens, knownMatchLen)`. Maps token indices to child slots via `tokenChildPrefix` (`Markdown.ts:1030`, maintained incrementally by `setTokens` at `Markdown.ts:1041`), then three paths per token: **reuse untouched**, **in-place mutate** (`setSpans`/`setCode`/`appendRows`), or **destroy + rebuild**.

Front matter is stripped **ahead** of lexing (`frontMatter.ts:94` `scanFrontMatter`, `Markdown.ts:1116` `initSource` / `Markdown.ts:1157` `consumeFrontMatter`) so the worker keeps no notion of it — `workerSourceLen` and `expectedLength` stay offsets into body text only. An unresolved opener is withheld up to `MAX_PENDING_CHARS = 4096` (`frontMatter.ts:62`) and released by `finalizeFrontMatter()` from the stream's `onClose` **before** `waitForAppendSettled` (`Markdown.ts:1409`).

### What the old path did

Before `incrementalLex`, `MarkdownWorker` held `{source, raws, version}` (`MarkdownWorker.ts:213` old shape), appended the delta, then lexed the **whole** accumulated source. The `99.5%` raw-prefix match ran _after_ the lex, so it saved entity rebuilds but could never save lexing — a linear parser invoked `N` times over a growing prefix. `postMessage` then re-sent the whole token tree. Both halves were `O(document)` per chunk; the benchmarks in § Numbers made it quotable before the fix did.

## Incremental lex — the committed-prefix idea

`marked` has no incremental API. The fix tracks a **stable block boundary** — a character offset before which the token list can no longer change — and re-lexes only the text after it.

### The stable-cut rule

`findStableCut` (`incrementalLex.ts:331`) scans backwards for a `space` token that has **at least one token after it**, never past the first of two adjacent `paragraph` tokens, and only when settled:

- A pushed `space` always means a **real blank line** — a lone `\n` is merged into the preceding token's `raw` (`incrementalLex.ts:36`).
- For every built-in rule, only the token adjacent to end-of-source can still change. The `nFollow >= 1` form was swept brute-force: safe for every predecessor type (`blockquote`, `code`, `heading`, `hr`, `html`, `list`, `paragraph`, `table`), while `nFollow == 0` fails for `code`/`list`/`paragraph` (`incrementalLex.ts:39`).
- **`list` needs a two-token lag.** `'- a\n\n- b\n'` is one `list` regardless of blank-line count; the same marker always merges. `cutIsSettled` (`incrementalLex.ts:314`) requires the token after the `space` itself be settled before a cut through a prior `list` is taken.
- **`blockMath` forward reach** is bounded by a blank line in the tokenizer: `(?:(?!\n[ \t]*\n)[\s\S])+?` (`Markdown.ts:294`, `MarkdownWorker.ts:122`). The earlier `(?!\n\n)` left whitespace-only lines unguarded — `'$$\nx\n   \n$$\n'` was still one `blockMath` (`incrementalLex.ts:67`).
- **`blockMath` backward reach** is `paragraphPairCap` (`incrementalLex.ts:289`): marked's `startBlock` clip can only fuse **two adjacent** `paragraph` tokens, and a stable cut always ends after a `space`, so a pair can never straddle a boundary. The old cure — degrade on any line-start `$$` — was sufficient but never necessary; narrowing to the cap recovered `139×` (see § Numbers).
- **Link references, `:::` containers, `[^label]:` footnotes** degrade outright (`DegradeReason` at `incrementalLex.ts:225`): a `def` retroactively rewrites earlier inline tokens (`incrementalLex.ts:122`), a container fence and the footnote continuation scanner (`markdown-footnote.ts` `consumeContinuation`) have unbounded forward reach. Degrade keeps correctness; declining a non-tiling advance (`advanceTiles` at `incrementalLex.ts:360`) costs one chunk of window growth instead.

Every advance is **verified** (`advanceTiles`, `incrementalLex.ts:360`): `source.slice` must equal the concatenated `raw` of tokens covering it. A source ending in a bare list marker `'- a\n- '` lexes to raw `'- a\n-\n'` — the assumption that `raw` tiles source is usually true but not always (`incrementalLex.ts:130`), so unverified advances are declined rather than degrading.

### Cost model

- `tail = prev.tail + append` — scanning `tail` alone keeps the check `O(window)` rather than `O(document)` (`incrementalLex.ts:490`).
- `charsLexed` (`incrementalLex.ts:248`) reports characters actually handed to `marked.lexer()` — the direct measure of what the boundary saved. `reusedTokens` reports leading tokens taken from cache.
- The naive `sourceCharsLexed` sum was itself re-summing `matchLen` raws per response — `O(n²)` over a stream (#657). Now `IncrementalLexCache.stableOffset` ships from the lex and is added `O(1)` (`Markdown.ts:989`, `Markdown.ts:2289`).

### Extensions in the hot path — why PX-0524 matters

Each `marked` extension registers a `start()` scan + tokenizer. The incremental path must classify it (see § Adding an extension) or `sourceCharsLexed` regresses to document length — the signal in `getDevtoolsDescriptor`'s `Parser cost` group (`Markdown.ts:2112`) that this instance degraded.

## Worker protocol — why transfer matters too

Re-lexing was not the only `O(N²)` term. `postMessage` **structured-clones** its argument synchronously on the main thread. Re-sending the whole document per chunk made transfer `O(document)` even after lex was windowed — measured `4 µs` at 8 KB rising to `220 µs` at 512 KB versus flat `~2 µs` for a chunk-sized post (`Markdown.ts:1017`).

The fix caches both the token raws **and** the source in the worker (`MarkdownWorker.ts:213` `rawCache`), keyed by `workerInstanceId` + `tokenVersion` (`Markdown.ts:1008`). Without `tokenVersion` bumping on every `setTokens` (`Markdown.ts:1043`), a `setContent` followed by an append would diff against stale raws.

- **Delta** — `append` + `expectedLength` (`Markdown.ts:2345`). The worker extends `cached.lex.source` with `append`, checks `cached.lex.source.length + append.length === expectedLength` (`MarkdownWorker.ts:308`) — one integer, no string work — and runs `lexAppend`.
- **Full** — `text` + `oldRaws` (`Markdown.ts:2355`), for first request, `setContent`, sync-fallback, or `needResync`. The worker asks for one resync (`MarkdownWorker.ts:294`, `299`, `334`) rather than lexing a diverged source — a wrong `matchLen` would corrupt the caller's `updateTokens`.

`matchLen` is computed off the **same** prior list the caller diffs against. When the worker reused `reusedTokens` of the lex, the scan starts at `reusedTokens` (`MarkdownWorker.ts:385`) — `O(window)`; falling back to scanning from 0 would be `O(document)` again. Eviction is bounded (`RAW_CACHE_MAX = 256` at `MarkdownWorker.ts:228`) by oldest-entry drops.

The caller snapshots `this.tokens` and `this.tokenVersion` at dispatch (`Markdown.ts:2252`) and coallesces while `appendInFlight` is true (`Markdown.ts:2220`). `dispatchedAt` timestamps feed `streamStats.workerMs / workerMsMax` (`Markdown.ts:2273`), whose worst value is the dropped-frame signal.

## Reconcile — token tree → entity tree, without rebuilding what didn't change

### The committed-prefix idea — intuition

Think of the document as two regions split at `stableOffset`:

```text
[████████████ stable █████████████████] [ unstable tail ]
 |  already committed — never re-lexed  |  may still change |
 |  raw-equal, entity-reused            |  this chunk's work |
```text

Appending text appended to the **tail only** can never affect a stable prefix — that is the invariant `findStableCut` earns by brute force. The tail is `O(window)` — bounded by the distance between blank lines plus any open container — so per-chunk work scales with the open region, not with document length.

### DevTools — observing it live

`getDevtoolsDescriptor` (`Markdown.ts:1989`) surfaces the streaming counters the narrative above quotes:

- `Streaming` — `appends` / `workerResponses` / `workerMsAvg` / `workerMsMax` (the dropped frame is `max`, not `avg`).
- `Delta shape` — `stablePrefixChars` / `changedTailChars` ratio (near 1 means high reuse) and `entitiesReused` / `entitiesRebuilt` / `inPlaceUpdates` (the fast path).
- `Incremental reuse` — `tokensPrefixMatched` / `tokensReturned` / `tokenPrefixReuseRatio`.
- `Parser cost` — `lexerMs` / `sourceCharsLexed`. If `sourceCharsLexed` tracks document length, this instance degraded.

### Mapping tokens to child slots

Not every block token renders an entity (`space`, non-SVG `html`, comment-like tokens render `null`). `producesEntity` (`Markdown.ts:4044`) is the predicate; `tokenChildPrefix` is its prefix sum, rebuilt only for the changed suffix by `setTokens(validFrom)` (`Markdown.ts:1041`). `updateTokens` then:

1. Derives `matchLen` — the raw-equal prefix length. When the worker supplied `knownMatchLen` it is validated (`0 ≤ knownMatchLen ≤ minLen`) rather than blindly trusted (`Markdown.ts:3689`).
2. Caps `matchLen` to `0` if `abbreviations` changed (`Markdown.ts:3711` `mapsEqual` over `collectAbbreviations`) — a late `*[TERM]: …` can affect earlier paragraphs' inline tokens despite unchanged `raw` (`markdown-abbr.ts` parallel to `hasLinkDefinitions`).
3. Tries an **in-place** fast path when `matchLen === oldTokens.length - 1` and types match (`Markdown.ts:3760` `lastTokenSameType`). Otherwise falls to destroy + rebuild for the suffix.

Note: `updateTokens`' destroy loop starts **at** `matchLen` — it used to walk from `0` with an `i >= matchLen` guard, making it `O(total blocks)` per chunk even when the prefix was fully reused (`Markdown.ts:3956`).

### In-place mutators — the growing-tail case

Streaming reality is **append-only with a growing tail**. Seven mutators cover the tail shapes a stream actually produces:

| tail token                  | mutator                                                                           | file:line                                                      |
| --------------------------- | --------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| `paragraph` (no image)      | `RichText.setSpans(literalSpans)`                                                 | `Markdown.ts:3833`                                             |
| `paragraph` (image-bearing) | `Stack` of `[RichText, Image, …]`: extend trailing `RichText` via `setSpans`      | `Markdown.ts:3846` `updateImageParagraph` (`Markdown.ts:3085`) |
| `code` (unclosed fence)     | `CodeBlock.setCode(text, lang)`                                                   | `Markdown.ts:3796`                                             |
| `heading`                   | `RichText.setSpans(headingSpans)` with depth guard                                | `Markdown.ts:3875`                                             |
| `blockquote`                | descend to `innerStack` tail wrapper, rewrite its single child                    | `Markdown.ts:3900` `updateBlockquoteTail` (`Markdown.ts:3306`) |
| `list`                      | rewrite last retained item's `setSpans`, `append` new items                       | `Markdown.ts:3914` `updateStreamedList` (`Markdown.ts:2987`)   |
| `table`                     | `RichText.setSpans` on last retained row's cells, `Table.appendRows` for new rows | `Markdown.ts:3932` `updateStreamedTable` (`Markdown.ts:3203`)  |

Every tail resync is `resizeLastChild` (`Stack.ts` fast path) — `O(1)` — not a full `Stack.layout()` (`Markdown.ts:3843`, `3859`, `3886`, `3904`, `3945`). The attribute arm `reflowToken` (`Markdown.ts:1520`) is the non-streaming counterpart for `setMaxWidth` — kept arm-for-arm with `renderToken` so width changes don't require rebuilding either.

`renderToken` (`Markdown.ts:4150`) is the construction site; `producesEntity` and `reflowToken` must stay in **three-way lockstep** across the arms it adds — a new arm without the other two is a silent bug for one of the three call sites.

### Layout of markdown blocks

Block geometry is driven by `LayoutEngine` (`packages/layout/src/LayoutEngine.ts:808`). `RichText` wraps at `availableWidth` (`Markdown.ts:4158`) via the vertical `Stack` gap `theme.blockGap`; blockquotes and `:::` containers indent their `innerStack` by `quoteIndent`/`containerIndent` and hang `QuoteBorder`/`ContainerBackground` off the resulting `Stack` height (`Markdown.ts:3403`, `Markdown.ts:4402`). `measureText` for affordance buttons uses the document font (`blockAffordances.ts:379`) so the control is sized before it paints. `LayoutEngine.prepareRich` is the line-breaker for `RichText`; its memo is keyed on content not width, so `setMaxWidth` re-wraps via shape not re-measurement — the same reason `reflowToken` exists.

### Scroll and selection hooks

The non-virtualized `Markdown` is a normal child of a `ScrollView` (`packages/ui/src/ScrollView.ts:219` spring driver): the host scrolls by setting `content.y` and calls `notifyLayoutUpdated` (`Markdown.ts:2643`) when re-layout moves blocks below an image. With `virtualize` on, `Markdown.setVisibleRange` (`Markdown.ts:1265`) is the scroll driver; off-screen height lives in `RowHeights`, not as detached entities. Selection lives in `RichText` spans; the `updateTokens` prefix-reuse keeps settled lines' `InlineObject` carriers (image/math `OBJECT_REPLACEMENT`) outside the compositor path, while the growing tail's `setSpans` preserves selection inside it without rebuilding line geometry.

## The O(C·N²) trap and the wrapper-instanceof bug

### O(C·N²) — the shape that tests didn't generate

A `table` token carries **every row**; a `list` token carries **every item**; a `blockquote` carries **every inner block**. The naive reconcile rebuilt all of them on every chunk:

- List of `N` items, streamed item by item: `1 + 2 + … + N = Θ(N²)` `RichText` constructions — measured `528` against `32` for a 32-item list (`Markdown.ts:3908` comment).
- Table of `N` rows, `C` columns: `Θ(C·N²)` cell constructions **plus** `Table.layout()` re-running `fitCell` on every cell — `2×` on top.

The aggregate transcript bench surfaced that `mixed` still rebuilt a just-arrived whole list on every following prose chunk — invisible to any single-construct shape (`benchmarks/markdown-transcript/corpus.ts`).

### The wrapper-instanceof miss — why streaming regressed under an opt-in flag

`blockAffordances: true` wraps code and tables in `BlockWithAffordances` (`blockAffordances.ts:433`) — a `UIComponent` that owns the block plus its copy/download `BlockAffordanceButton` children, sizes itself from the block (`blockAffordances.ts:457`), and projects as `role: group` (`blockAffordances.ts:488`). The wrapper fixes DOM order = tab order and avoids stealing layout from `Stack`/`Table`.

The streaming fast path tested `existingEntity instanceof Table` / `instanceof CodeBlock` directly. With the wrapper on, those tests **always returned false**, so every chunk paid the full rebuild.

Affected sites before the fix: `updateTokens` (`Markdown.ts:3781`, `Markdown.ts:3209`), `updateBlockquoteTail` tail extraction (`Markdown.ts:3348`), `reflowToken` `code`/`table` arms (`Markdown.ts:1557`, `Markdown.ts:1651`), `updateStreamedTable` (`Markdown.ts:3212`). The pattern is:

```ts
const target = entity instanceof BlockWithAffordances ? entity.block : entity;
if (!(target instanceof Table)) return false;
// … and after a width/content change:
if (entity instanceof BlockWithAffordances) entity.refreshAffordances();
```text

`#789` / `#795` (`vectojs` issue) is this bug. `code-review-2026-08.md:167` records all sites together because they cluster.

### Why snapshot tests missed it

The markdown suite is dominated by `setContent`-based snapshots. `setContent` **always rebuilds** (`Markdown.ts:1740`): it resets `tokenVersion`, clears children, and calls `renderMarkdown`. It **never exercises** the streaming reconcile path (`updateTokens` + `inPlaceUpdates`/`entitiesRebuilt`/`tokenChildPrefix` + wrapper unwrapping). An extension or option that only breaks the reuse path therefore passed every snapshot and only failed under `appendMarkdown` at token granularity. The `1/11` sabotage that drove `setContent` and claimed to guard reuse is the canonical example (`forge/findings/text-richtext-and-markdown.md:552`).

Gate rule: any streaming change must include **streaming-equivalence sabotages** — streaming the corpus one char at a time with deep `toEqual` against `marked.lexer()` at every prefix (`incrementalLex.test.ts` pattern) and with `appendMarkdown` granularity for reconcile.

### The PX-0524 extension blowup — when incremental still isn't free

Adding syntax coverage (footnote, container, emoji, abbr, ins/mark, superscript — `markdown-footnote.ts` `FOOTNOTE_EXTENSIONS`, `markdown-container.ts` `CONTAINER_EXTENSIONS`, `markdown-emoji.ts` `EMOJI_EXTENSIONS`, `markdown-abbr.ts` `ABBR_EXTENSIONS`, `markdown-ins-mark.ts`, `markdown-superscript.ts`) took the shared `marked` instance from `2` extensions at `faeeb0b7` to `12` at `2a4bd52`. Each one is a `start()`/`tokenizer` pair that `marked` consults **per block and per inline span** — so even with `incrementalLex` windowing the lex to `O(tail)`, the per-chunk cost is `O(tail × extensions)`. The `1.67×` parse rise in § Numbers is this cluster priced per chunk, never measured when it shipped. `markdown-math.ts:258` `blockMath`/`inlineMath` are the two that were already paid; the other ten are the step change. Lesson: any extension addition must re-run `markdown-transcript` and `stream-markdown-smd` parity gates — a constant-factor win from incremental can be eaten by a constant-factor loss from extension count.

### Destruction and the late-arriving raster

Two other lifecycle hooks compete with streaming. `Markdown.destroy()` (`Markdown.ts:1938`) drops every `workerCallbacks` entry that pins `this` via its closure — without that a mid-stream destroy would keep the whole subtree alive until the worker replied. `isDestroyed` gates `mathLoadPending` continuation (`Markdown.ts:1952`) so a torn-down tree does not re-render into a detached subtree.

Inline images and math have their own post-stream fixups. A paragraph image's `onLoad` at `Markdown.ts:2562` re-measures from `naturalWidth`/`naturalHeight` and calls `reflowAfterImageResize` (`Markdown.ts:2604`), which re-derives wrapper boxes bottom-up (`resyncWrapperBox` at `Markdown.ts:2674`) — a bare `content.layout()` would re-read the stale parent cache (`Markdown.ts:2591` comment). An inline image inside a heading or table cell cannot be resized the same way — its box is baked into `LayoutEngine`'s line; instead `subscribeInlineImageRemeasure` (`Markdown.ts:1819`) re-typesets when `inlineImageBoxesStale` (`Markdown.ts:1855`) reports a non-square decode, but only once per URL (`inlineImagesMeasured` at `Markdown.ts:1894`). Math is analogous: `ensureMathJax` (`Markdown.ts:3518`) coalesces concurrent loads onto one `preloadMathJax` promise, and `retypesetFromTokens` (`Markdown.ts:3551`) rebuilds wholesale from the already-lexed tokens — the only path that keeps `tokenChildPrefix` trivially correct.

## Five-way tension — the design must satisfy all at once

| force                   | what it demands                                                                                                                                                     | where it lives                                                                                                                                                       |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Correctness**         | `lexFull(source)` and streaming appends are **deeply identical** to `marked.lexer(source)` at every prefix length; `updateTokens` result equals `setContent` result | `incrementalLex.test.ts` char-at-a-time fuzz, `markdownWorkerProtocol.test.ts` diff gates strengthened to **tree equality**                                          |
| **Incrementality**      | Per-chunk work is `O(window)` (unstable tail), not `O(document)` — unbounded tail growth is a regression                                                            | `stableOffset` / `charsLexed` / `changedTailChars` counters; `sourceCharsLexed` must track payload share, not document length                                        |
| **Selection stability** | Appending must not move or destroy the selection inside a settled, stationary on-screen block                                                                       | `tokenChildPrefix` + reuse of `matchLen` prefix entities; `updateTokens` never touches prefix children (`Markdown.ts:3956`)                                          |
| **Layout stability**    | No off-screen block should shift the layout of an already-painted on-screen block mid-stream                                                                        | No `finalizeFrontMatter` shrink of `rawMarkdown` (protocol requirement); `resizeLastChild` tail-only resync; no image-resize reflow that re-reads stale parent boxes |
| **Performance**         | Render/layout work per chunk stays within the frame budget after the incremental win                                                                                | § Numbers — reconcile now `~5%` of total; render `61%` and parse `33%` dominate                                                                                      |

Violating one to help another is a recurring pattern: the "obvious" front-matter fix (lex then remove) shrinks `rawMarkdown` and breaks the worker protocol's `expectedLength`; an image fix that re-lays out from `content` alone without resyncing wrappers leaves stale parent boxes (`Markdown.ts:2595` `reflowAfterImageResize`).

## StreamController — pacing, backpressure, and who owns close

`Markdown.appendMarkdown(chunk)` is the raw append. `Markdown.createStream(opts)` (`Markdown.ts:1384`) wraps it in a `StreamController` (`StreamController.ts:129`) that adds three things the raw path does not — all optional, all display-only, none allowed to drop characters:

- **Frame coalescing.** Without pacing, each `write()` would post to the worker and schedule a reconcile. The controller batches into `requestAnimationFrame` ticks (`StreamController.ts:351` `schedule` / `onFrame`). The simplest caller uses no `pacing` option — just RAF batching — which is the common ChatGPT-style SSE case.
- **Grapheme pacing.** `pacing: { graphemesPerSecond }` (`StreamController.ts:22`) drains the internal `chunks` queue via `commitPaced` (`StreamController.ts:378`) with `Intl.Segmenter` grapheme counting so a typewriter effect advances one grapheme cluster per tick, not one UTF-16 code unit (emoji stay intact).
- **Backpressure.** `maxBufferedChars` (`StreamController.ts:29`, default `64 KiB`) bounds the queue; `write()` backpressures when full (`StreamController.ts:183` `canAdmit` / `blocked`). This is flow control, not incremental correctness — the bounded buffer never truncates the document.

Lifecycle is `createStream → write* → close() → onStable`. `createStream` throws if `virtualize` is on (`Markdown.ts:1385`) or a stream already exists (`Markdown.ts:1388`) — at most one controller per instance; `updateTokens`'s single-slot `appendInFlight` + `appendPending` coalescing assumes it. `close()` commits any pending chunks synchronously (`StreamController.ts:244` `commitAllSubmitted`), flips state to `closed`, then awaits the host's `onClose` hook (`Markdown.ts:1404`) which runs `finalizeFrontMatter` and `waitForAppendSettled` (`Markdown.ts:1413` — the last worker reply + any `mathLoadPending` `preloadMathJax` + `fencedRebuildPending`). Only then does `onStable` fire (`Markdown.ts:1419`) with `Array.from(content.children)` — a snapshot, not a live reference (`incompleteMode.test.ts:313`). `onStable` must not call `appendMarkdown`/`setContent`/`setMaxWidth` (`Markdown.ts:3669` `assertNotInStableCallback`) — it is handed the finished document for one-time work like baking a highlight cache.

## Optimistic incomplete syntax — guessing at the trailing edge

A streamed prefix ending in `**bo` should show **bold** immediately, not raw `**`. `StreamControllerOptions.incompleteMode` (`StreamController.ts:43`) controls this; `Markdown.streamIncompleteMode` (`Markdown.ts:853`) holds the policy while `StreamController` owns only buffering.

- `'literal'` (default) — what every release before this option shipped: unclosed syntax renders as `marked.lexer`'s plain text, so `**bo` stays `**bo` until the closer arrives.
- `'optimistic'` — `optimisticParagraphSpans` (`Markdown.ts:3415`) scans the **last inline token** of the **trailing** paragraph only (a closed construct is already its own `strong`/`em`/`codespan`/`link` token, so only the final plain-text run can hold an opener). `findUnclosedInline` (`markdown-inline.ts:546`) checks three syntaxes in priority: backtick (wins outright — inside a code span nothing else is syntax), emphasis `*`/`_` (`\*{1,2}(?!\*)` whole-marker plus non-space guard; `_` excludes `snake_case` at `markdown-inline.ts:570`), and `[label](url` (`markdown-inline.ts:581`). The guess renders that run with the guessed formatting (`optimisticStyle` at `Markdown.ts:3484`) and tracks it in `optimisticTail` (`Markdown.ts:866`). A coalesced append can leave the guessed paragraph non-trailing — `dropStaleOptimisticTail` (`Markdown.ts:3611`) rewinds it immediately rather than waiting for `close()`. On `close()` any remaining guess unwinds to literal spans (`Markdown.ts:3574` `unwindOptimisticTail`) so `literal` and `optimistic` streams end identically. Math (`$…$`) is not guessed — its `InlineObject` (`markdown-inline.ts:301`) reserves `width/height/depth` via `exToPx` (`markdown-math.ts`), not a span style.

## Virtualization vs streaming — mutual exclusion is not a policy choice

`virtualize` (`Markdown.ts:760`) windows top-level blocks as entities via `virtualTokens`/`virtualHeights` (`RowHeights`) and `reconcileVirtual` (`Markdown.ts:1340`), driven by the host's `setVisibleRange` (a `ScrollView` does this automatically). It **cannot** be combined with streaming (`Markdown.ts:1385`, `Markdown.ts:2187` both throw): the entity for an off-screen block does not exist, so `updateTokens`'s `tokenChildPrefix` + `matchLen` prefix reuse would address a child slot that is not mounted.

`tableViewportHeight` (`Markdown.ts:771`) is the escape hatch — it virtualizes **rows inside each table** via `Table.appendRows` + `reconcileVirtualRows` (`Table.ts:334`) and `bodyClip` pinning, and it _does_ work while streaming because `updateStreamedTable` appends rows through the same `appendRows` that already mounts lazily. Choose `virtualize` for a huge static document; choose `tableViewportHeight` for a streamed doc dominated by wide tables.

### Paragraph shape traps — why `producesEntity` is not just an optimisation

`producesEntity` deciding `text → image` via `paragraphHasImage` (`Markdown.ts:3807` guard) is correctness, not speed: without it a paragraph that gains its first image keeps its `RichText` and the picture is silently dropped (`collectSpans` emits nothing for an `image` token). The list-item analogue is `itemIsInlineOnly` (`Markdown.ts:2759`) — throwing `checkbox` out of `INLINE_ITEM_TOKENS` (`Markdown.ts:2738`) forces every task item through the block path and breaks task-list rendering; the allowlist is what keeps a future block type from being flattened into a `RichText`.

## Measured numbers — quote with the baseline

Only `benchmarks/run-browsers.sh` numbers (real headed Chrome/Firefox, real GPU, `calibrateRefreshRate()`, dedicated Hyprland workspace per `hyprland-browser-bench` skill) are quotable. Headless `script/benchmark.ts` and `benchmarks/debug-page.ts` are tripwire/debug.

### Reconcile win — aggregate transcript (`markdown-transcript-aggregate-2026-07-30`, CTX-0148, PR #296, commit `0e4a4233`)

Workload: `6` turns, `176` blocks, `27,882` chars, `6,543` chunks, **`token` granularity** — granularity dominates: `151` vs `14` chunks for the same doc at `token` vs `48`-char, `7×` reuse difference (`markdown-transcript-aggregate-2026-07-30.md:111`). Two runs per arm; only `lastTokenSameType` flipped.

|                    | no reuse  | today     | delta      |
| ------------------ | --------- | --------- | ---------- |
| reconcile, Chrome  | 1635.2 ms | 319.5 ms  | **−80.5%** |
| reconcile, Firefox | 992.2 ms  | 245.0 ms  | **−75.3%** |
| render, Chrome     | 3626.8 ms | 3393.7 ms | −6.4%      |
| parse, Chrome      | 1978.3 ms | 1826.2 ms | −7.7%      |
| total, Chrome      | 7240.4 ms | 5539.4 ms | **−23.5%** |
| total, Firefox     | 6334.1 ms | 5404.3 ms | **−14.7%** |

**Phase shares as shipped** (shipped total `5539 ms` Chrome / `5404 ms` Firefox, `0.86 / 0.82 ms` per chunk): render `61.3 / 61.4%`, parse `32.9 / 34.1%`, **reconcile `5.8 / 4.6%`** — reconcile is now the **smallest** phase; remaining per-type reuse headroom is bounded by that ceiling.

### Panel-rate re-run (2026-08-08, `2a4bd52`, Firefox now at panel Hz)

| engine  | Hz              | parse       | reconcile | render      | total       |
| ------- | --------------- | ----------- | --------- | ----------- | ----------- |
| Chrome  | 240.09 / 239.95 | 2826 / 2830 | 459 / 456 | 3386 / 3388 | 6670 / 6674 |
| Firefox | 229.01 / 241.26 | 3190 / 3282 | 311 / 315 | 3581 / 3691 | 7082 / 7288 |

Per-chunk render `0.517 / 0.556 ms` = `12.4 / 13.3%` of a `4.16 ms` frame; total per chunk `1.02 / 1.10 ms` = `24.5 / 26.4%`. The `≈60 Hz` Firefox figure in the original run (`58.75 Hz`) was **not** an unfocused-window artifact — it was `layout.frame_rate = -1` (`forge/findings/devtools-and-telemetry.md:2026-08-03`).

**Real regression surfaced:** parse rose `1.67×` on both engines. Lexing the same `6543`-chunk corpus against bare `marked` vs the shared 12-extension instance: `1871 → 3127 ms` (`1.671×`). Cost is per-chunk per-extension `start()`/`tokenizer`. At `faeeb0b7` the instance carried `2` extensions; at `2a4bd52` it carries `12` — the **unmeasured price of the PX-0524 cluster**. Parse share moved `33% → 42–45%`. The `incrementalLex` figure is _after_ the lex was already windowed — without it would be worse.

### Incremental lex win — prose fixture (`comparisons/stream-markdown-smd`, Chrome 150 / Firefox 153, 784 chunks)

Before: full re-lex per chunk, `419.6 / 440.2 ms`, exponent `1.98`, chars handed to lexer `9,847,040`. After: `6.02 / 9.06 ms`, **`69.8× / 48.6×`**, exponent `0.94 / 1.21`, chars `63,806`, exponent `1.00` (`forge/findings/text-richtext-and-markdown.md:2026-08-03`).

### Math streaming after the cap narrowed (`markdown-stream-math`, vectojs#398)

Blanket `blockMath` degrade → cap-only: **`139.3× Chrome / 96.5× Firefox`** on a `26,760`-char, `200`-section math doc; characters to lexer `215.9×` reduction; boundary settles at `99.84%` of document; max single-chunk lex `105` chars at every size (`forge/baselines/markdown-stream-math-findings.md`).

## Adding a new markdown extension without regressing streaming

An extension is two registrations (`Markdown.ts:240` and `MarkdownWorker.ts:95` — same `marked.use` call, **both sides**, same tokenizer — drift breaks the worker's view of `marked`). Four checks, in order:

### 1. Classify the extension's reach

- **No `start()` and bounded by blank line** → safe; no boundary change. Example: inline rules (`abbr` `markdown-abbr.ts`, `emoji` `markdown-emoji.ts`, `footnote` ref `markdown-footnote.ts` half) need no degrade.
- **Supplies `start()`** → backward reach; `paragraphPairCap` already caps it, but **verify** — any new `start()` is covered because the clip is marked's, not `blockMath`'s (`incrementalLex.ts:103`).
- **Spans a blank line** → forward unbounded reach; `hasContainerOpener` / `hasFootnoteDefOpener` pattern (`markdown-container.ts: hasContainerOpener`, `markdown-footnote.ts: hasFootnoteDefOpener`). **Degrade** via `DegradeReason` (`incrementalLex.ts:225`) — a cut ceiling cannot bound it.
- **Collects late definitions** (`marked` `def` pattern, `abbrDef` is the narrow case that forced `abbreviationsChanged` zeroing `matchLen` at `Markdown.ts:3711`) → forces rebuild or degrade; document why.

If uncertain, **degrade** — it is always correct and only costs streaming docs that actually contain the opener.

### 2. Register in lockstep and verify the guard

- Identical `blockMath` tokenizer copies in `Markdown.ts:294` and `MarkdownWorker.ts:122` already drifted once (`[\s\S]+?` vs blank-line guard), and the worker is generated via `scripts/build-worker.js` → `MarkdownWorkerSource.ts`. Extract a shared module if it drifts a third time (`markdown-stream-math-findings.md: Also fixed`).
- For a blank-line-guarded tokenizer, the guard must be `(?!\n[ \t]*\n)` (whitespace-only lines inclusive), not `(?!\n\n)` (`incrementalLex.ts:67`, #398).

### 3. Teach every entity-aware site

For the token type your extension adds:

- `renderToken` — construction (`Markdown.ts:4150`).
- `producesEntity` (`Markdown.ts:4044`) — `true` iff it renders an entity; `false` exactly for tokens that render `null` (otherwise `tokenChildPrefix` drifts).
- `reflowToken` (`Markdown.ts:1520`) — width-change path; missing arm leaves the block at its old width.
- `updateTokens` in-place branch (`Markdown.ts:3760`) — opt in only if a tail-growing shape has a mutator (`setSpans`/`setCode`/`appendRows`); container types (`blockquote`, `list`, `table`) go through tail-descent not direct mutation.
- If the block can be affordance-wrapped, unwrap: `instanceof BlockWithAffordances ? .block : entity` — and call `refreshAffordances()` after mutating the inner size (`Markdown.ts:3209`, `Markdown.ts:3781` pattern).
- If inline images/math can appear inside the new block, cover `containsImage`/`containsInlineMath` subscription (`Markdown.ts:4166`) and `reflowAfterImageResize` wrapper resync.

### 4. Add the sabotage, not just the snapshot

- `incrementalLex.test.ts` char-at-a-time fuzz: stream the corpus containing the new construct one char at a time, deep `toEqual` against `marked.lexer()` at every prefix. Keep the brute-force sweep over `14 docs × every prefix × every cut` that justified `findStableCut`; run it with and without the extension to prove `nFollow >= 1` still holds.
- **Streaming reconcile sabotage**: stream a doc containing the construct at **token granularity** via `appendMarkdown` (not `setContent`), assert `inPlaceUpdates`/`entitiesRebuilt`/`charsLexed` move in the expected direction, and assert deep token-tree + pixel equality against `setContent` — a sabotage that drives `setContent` cannot fail the reuse path.
- Re-run the `comparisons/stream-markdown-smd` parity gates at **deep tree equality** outside the timed loop and the threshold gates on both engines — per `forge/findings/text-richtext-and-markdown.md:2026-08-03` only tree equality catches a fast number for a broken parse.

### Timeline — one chunk through the two regions

```text
chunk " world": "Hello **bo" → "Hello **world**"
  before: stable="Hello "  tail="**bo"        (paragraph, trailing plain run)
   lex:   tail re-lex → [text("Hello "), strong("world")]  charsLexed = tail.length
   diff:  matchLen=0 (paragraph raw changed), tail = [paragraph(strong)]
   reconcile: heading/paragraph didn't match → destroy old RichText, add new one
  after:  stable="Hello **world**\n\n"  tail=""  (blank line committed, entitiesReused++)
```text

The commit happens when a blank line arrives and `findStableCut` can advance. Until then every chunk revisits the same tail — bounded, not growing with document length.

## Debugging streaming — what to check first

1. **`sourceCharsLexed` tracks document length** → degraded (`DegradeReason` at `incrementalLex.ts:225`); check for `:::`/`[^`/`def`/`\r` in the doc or a missing tail-only scan (`incrementalLex.ts:490`).
2. **`inPlaceUpdates` flat while `entitiesRebuilt` climbs** → in-place miss; grep `instanceof RichText`/`CodeBlock`/`Table` without `BlockWithAffordances` unwrap — classic wrapper bug (`code-review-2026-08.md:167`).
3. **Snapshot passes, streaming fails** → `setContent` path (`Markdown.ts:1740`) never exercises `updateTokens`; write the char-at-a-time sabotage.
4. **Last chunk missing after `close()`** → `waitForAppendSettled` not awaited; check `appendInFlight`/`mathLoadPending`/`fencedRebuildPending` gating at `Markdown.ts:2429`.
5. **Selection jumps on append** → prefix not reused; check `tokenChildPrefix` valid range (`Markdown.ts:1041` `validFrom`) and `matchLen` validation (`Markdown.ts:3689`).
6. **Off-screen block reflow after image decode** → `reflowAfterImageResize` wrapper path (`Markdown.ts:2604`) stale; check `resyncWrapperBox` covers the wrapper type.

## Invariants — the checklist before PR

1. **Deep lex identity.** `incrementalLex(charByChar(S))` deeply equals `marked.lexer(S)` at every prefix, including whitespace-only blank lines and bare list markers.
2. **Transfer identity.** `matchLen` prefix raws equal, and `[...oldTokens.slice(0,matchLen), ...tail]` equals the full lex — validated at `Markdown.ts:3689` and in the worker at `MarkdownWorker.ts:308`.
3. **Entity-index agreement.** `producesEntity ↔ renderToken null ↔ reflowToken arms ↔ tokenChildPrefix` four-way; tested with `BlockWithAffordances` **on**.
4. **Tail-only mutation.** No in-place path touches a prefix child; every early return leaves the entity untouched so a refused reuse is not a half-update.
5. **Quota linear in streaming cost.** Per-chunk quota (if enforcing) is linear in `append` cost (`charsLexed` window), and only smooth input is throttled — buffered sends commit whole (`StreamController.ts` pacing is display-only; correctness never drops chars).
6. **Depth-stable heading.** `heading` in-place reuses only when `oldDepth === newDepth` (`Markdown.ts:3875`); otherwise `font` would be stale (`RichText` constructor-only).

## References

- `vectojs-docs/content/learn/streaming.md` — user-facing streaming API and `createStream` lifecycle.
- `vectojs-docs/content/learn/text-typography.md` — why inline math/images and `RichText`/`LayoutEngine` interact with streaming.
- `vectojs-docs/forge/findings/text-richtext-and-markdown.md` — field notes for every streaming bug whose measurement earned a line above.
- `vectojs-docs/forge/baselines/markdown-transcript-aggregate-2026-07-30.md` and `markdown-stream-math-findings.md` — the two quotable baselines and their engines/commits.
- `vectojs-docs/forge/code-review-2026-08.md:167,170` — the `BlockWithAffordances` `instanceof` + `refreshAffordances` cluster (`#789`/`#795`, `#701`).
- `packages/markdown/test/incrementalLex.test.ts` and `markdownWorkerProtocol.test.ts` — the streaming-equivalence and protocol contracts any new extension must keep green.

---

_Next: 05 Zero-DOM TeX — the typesetting kernel, `InlineObject` and `SVGEntity` emission that streaming math and tables measure against._
