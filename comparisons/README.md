# Library comparisons

Head-to-head comparisons between VectoJS and other libraries, written as
**runnable code measured in real browsers** rather than a hand-written feature
matrix. Each subdirectory is a self-contained benchmark following the same
three-file contract as `benchmarks/` (`build.ts` / `entry.ts` / `serve.ts`), run
through `comparisons/run-browsers.sh`.

## Ground rules

These exist to be useful, not flattering. So:

1. **Same workload, both libraries, same page, same run.** A number is a delta
   measured on one engine, never an absolute quoted from someone else's README.
2. **Real browsers, both engines.** V8 and SpiderMonkey diverge substantially on
   these workloads (see the results below — the gap ratio differs by 3× between
   them). Headless is a software-raster floor and is not used for absolute claims.
3. **State the scope difference.** Most of these libraries are not trying to do
   what VectoJS does, and vice versa. A benchmark that ignores that is
   marketing, not engineering.
4. **Compare like for like.** If their API returns less work than ours, either
   measure our equivalent-work path or say plainly that the comparison is
   asymmetric. Don't compare their cheap call to our expensive one.
5. **Report losses.** Where we're slower, that's recorded here and turned into a
   TODO — see the Pretext case, which produced a real optimization.

Reference sources for the libraries under comparison are cloned (shallow) into
`references/` (workspace root) — read their actual implementation before writing a comparison.

Libraries being compared against are added as root `devDependencies` (e.g.
`@chenglou/pretext`). They are dev-only and never reachable from any published
`@vectojs/*` package, so they cannot leak into a consumer's dependency tree.

## `text-layout-pretext` — vs [`@chenglou/pretext`](https://github.com/chenglou/pretext)

Pretext (Cheng Lou, March 2026) independently arrived at the **same
architecture** as `@vectojs/layout`: a one-time `prepare()` that measures text
via canvas and caches segment widths, then a cheap `layout()` that is pure
arithmetic over those widths, so resize never touches DOM layout. That makes it
the single most directly comparable library here.

**Scope differs, and it matters:**

|                                        | pretext                                                   | `@vectojs/layout`                                      |
| -------------------------------------- | --------------------------------------------------------- | ------------------------------------------------------ |
| Output                                 | line count + height (`layoutWithLines` for line contents) | positioned glyphs                                      |
| Renders                                | nothing — you draw                                        | feeds the VectoJS renderer                             |
| Consumers of the output                | your code                                                 | selection geometry, caret hit-testing, a11y projection |
| BiDi                                   | yes (`computeSegmentLevels`)                              | yes (full UAX #9 + Arabic shaping)                     |
| Scene graph / hit-testing / components | no                                                        | yes (that's the rest of VectoJS)                       |

So "which resolves line breaks faster" is a fair question. "Which should I use"
is not answered by this benchmark — if you only need text measurement, pretext
is a much smaller dependency.

### What the benchmark found, and what we changed because of it

Measured Chrome 150 / Firefox 153, median of 7, 500 prose blocks relaid out at 4
widths (baselines in `vectojs-docs/forge/baselines/cmp-text-layout-pretext-*`):

| relayout hot path                                  | Chrome      | Firefox     |
| -------------------------------------------------- | ----------- | ----------- |
| `layoutPrepared()` (positions every glyph)         | 30.71 ms    | 25.38 ms    |
| **`measurePrepared()`** (line count + height only) | **0.92 ms** | **4.02 ms** |
| `pretext.layout()`                                 | 0.77 ms     | 1.32 ms     |

The first row is the honest starting point: **pretext's hot path was ~39× faster
than ours.** Reading their `line-break.ts` showed why — their `layout()` walks
**segment-level** width arrays and only counts lines (O(segments), zero
allocation), while `layoutPrepared()` positions **every glyph** and allocates a
`LayoutNode` per glyph on every relayout (O(glyphs), ~5–10× more items).

That's a scope difference, not a defect — we need glyph positions for selection
and a11y. But we were paying glyph cost even for callers that only want
"how tall is this at this width": a virtualized list measuring rows, a resize
pass, an autosizing container.

So this comparison produced **`LayoutEngine.measurePrepared()`**: the same greedy
wrap decisions walked over prepared _word_ widths, no glyph positioning, no
allocation. It's **15–33× faster than the full path in Chrome, 6–7× in Firefox**,
which closes the gap to pretext to **1.19×** at 500 blocks (Chrome). It is
covered by 27 tests asserting it agrees with `layoutPrepared()` on line count and
height — including the mid-word overflow case the first prototype got wrong.

**Caveat we do not paper over:** `prepare()` looks ~60× faster in VectoJS in this
benchmark, but only because the engine caches prepared paragraphs internally and
the corpus repeats. That is not a like-for-like win and is deliberately excluded
from any published table.

## `render-canvas-libs` — vs [Konva](https://konvajs.org) / [Fabric.js](http://fabricjs.com) / DOM

For a _rendering_ library, a throughput number alone is misleading. What actually
differs is what a user and a screen reader can do with the result. This page
renders the same label + button four ways and probes the live DOM.

Chrome 150 (DPR 1) and Firefox 153 (DPR 1.579 — a fractional ratio, deliberately):

|                 | backing-store ratio | a11y tree | accessible name  | text selectable |
| --------------- | ------------------- | --------- | ---------------- | --------------- |
| DOM (baseline)  | n/a                 | yes       | `Run export`     | yes             |
| **VectoJS**     | matches DPR         | **yes**   | **`Run export`** | **yes**         |
| Konva 10.3.0    | matches DPR         | no        | —                | no              |
| Fabric.js 7.4.0 | matches DPR         | no        | —                | no              |

**DPR is not a differentiator — do not claim it as one.** All three canvas
libraries scale their backing store correctly, including at Firefox's fractional
1.579. Text is crisp in all four (screenshot baseline:
`cmp-render-canvas-libs-chrome150-dpr2-2026-07-26.png`).

The real difference is the semantic layer. `getByRole('button', { name: 'Run
export' })` resolves in VectoJS and in the DOM baseline; in Konva and Fabric there
is nothing to resolve, and the drawn text cannot be selected or copied. That is
consistent with their source: **zero `aria-` or `role=` occurrences anywhere in
`konva/src` or `fabric/src`.**

This is a scope statement, not a criticism. Konva and Fabric are scene-graph and
object-model libraries; accessibility is left to the embedder. If you need it, you
build the shadow layer yourself — which is the thing VectoJS is.

### Method note

The first `grim` capture of this page showed the VectoJS panel **entirely black**,
which looked like a rendering failure. It wasn't: the canvas had 5,335 non-background
pixels: the screenshot was taken before the render settled. The page now emits a
`#probe-done` marker and the driver waits for it. Trusting that first screenshot
would have produced a false bug report — capture after an explicit settle signal,
and cross-check pixels programmatically before believing an image.

## `layout-flex-canvas-ui` — vs [`@canvas-ui/core`](https://github.com/alibaba/canvas-ui)

Of every library cloned into `references/`, Alibaba's Canvas UI is the only one
attempting what VectoJS attempts: a general UI runtime that renders components to
a canvas with a DOM-like scene tree, its own text layout, and a box layout system.
Konva and Fabric are scene-graph and object-model libraries with no layout system
at all, which is why `render-canvas-libs` compares those on rendering and
semantics instead.

It also makes the opposite architectural bet on layout, which is what makes it
worth measuring: **canvas-ui delegates layout to Yoga**, Facebook's C++ flexbox
engine, while VectoJS computes layout in hand-written TypeScript.

**This is not "WASM vs JS", and the difference matters.** canvas-ui 2.0.0 depends
on `yoga-layout-prebuilt-fork@1.10.6`, which ships **asm.js**: its
`build/Release/nbind.js` contains `"use asm"` and zero references to
`WebAssembly`, and the package contains no `.wasm` file at all. So this is an
Emscripten/nbind asm.js port against natively JIT-compiled TypeScript — asm.js
pays marshalling on every boundary crossing and no longer gets the dedicated
ahead-of-time pipeline it once did.

**Scope differs, and it matters:**

|              | `@canvas-ui/core` `RenderFlex`                                                                    | `@vectojs/ui` `Stack`               |
| ------------ | ------------------------------------------------------------------------------------------------- | ----------------------------------- |
| Layout model | much of flexbox: grow/shrink/basis, wrap, justify, align items/content/self, min/max, %, absolute | single-axis stacking                |
| Knobs        | per-side margin **and** padding                                                                   | `direction`, `gap`, `align`, `wrap` |
| Backend      | Yoga (asm.js)                                                                                     | hand-written TypeScript             |
| Invalidation | style write → dirty → `pipeline.flushLayout()`                                                    | `add()` positions immediately       |

`Stack` is a strict **subset**. The benchmark therefore drives only the workload
both express natively — stacked rows of fixed-size children with a gap — and is
**not** evidence that `Stack` could replace `RenderFlex`. One asymmetry is
accepted rather than hidden: canvas-ui has no `gap`, so the gap is per-child
leading margin, which gives Yoga per-child margin work `Stack` folds into one
scalar.

### What the benchmark found

Chrome 150 / Firefox 153, median of 15 with 3 warmup passes, 500 rows × 3 cells
= 2001 nodes (baselines in `vectojs-docs/forge/baselines/cmp-layout-flex-canvas-ui-*`):

| 500-row tree                                 | Chrome        | Firefox       |
| -------------------------------------------- | ------------- | ------------- |
| build — VectoJS `Stack`                      | **0.333 ms**  | **0.916 ms**  |
| build — canvas-ui, append all then one flush | 182.51 ms     | 172.04 ms     |
| build — canvas-ui, flush per row (streaming) | 468.36 ms     | 730.54 ms     |
| relayout — VectoJS `Stack.layout()`          | **0.0217 ms** | **0.0415 ms** |
| relayout — canvas-ui end-to-end              | 16.36 ms      | 19.24 ms      |
| ⤷ of which: marking dirty                    | 13.38 ms      | 10.74 ms      |
| ⤷ of which: Yoga computing (`flushLayout`)   | 3.68 ms       | 6.62 ms       |

**The headline ratio is not a layout-algorithm result, and reporting it as one
would be wrong.** End-to-end relayout differs by 755× (Chrome), but the split
shows **78% of canvas-ui's Chrome cost, and 62% of its Firefox cost, is spent
before Yoga computes anything** — in the `StyleMap` Proxy trap, an eventemitter3
`emit`, the asm.js `setWidth` marshalling, and `markLayoutDirty`. Against Yoga's
`flushLayout` alone the gap is **170× / 159×**, and Yoga's own cost of ~1.8 µs per
node is not embarrassing. The invalidation path, not the flexbox engine, is what
dominates — and a caller cannot avoid it, because a style write is canvas-ui's
only way to invalidate.

The one clear algorithmic difference is **incremental build**: canvas-ui's
flush-per-append is 2.6× (Chrome) / 4.2× (Firefox) slower than its own batched
path at 500 rows, up from 1.1× at 50 rows — superlinear, because each flush
re-lays the dirty subtree. `Stack.add()` has an O(1) append fast path, so its
build is linear (per-node cost flat, and slightly _falling_, at 0.179 → 0.170 →
0.166 µs across 50/200/500 rows in Chrome). A streaming feed appending one row at
a time is the workload where that difference is felt.

### Method note — two gates, both verified by sabotage

Neither gate is decoration; each caught a real defect in this suite's own first draft.

1. **Geometry agreement, checked before any timing.** The first version expressed
   only the horizontal gap on the canvas-ui side, so its column was 80 px tall
   against VectoJS's 104 — it would have looked faster for doing strictly less
   work. The page now suppresses **every** timing unless both engines produce
   identical geometry. Verified by re-introducing the bug: `geometryAgrees: false`
   and zero rows measured.
2. **Proof that the relayout actually reflowed.** canvas-ui's `RenderFlex`
   container-style handlers (`flexDirection`, `flexWrap`, `justifyContent`,
   `alignItems`, `alignContent`) set the Yoga property but **never call
   `markLayoutDirty()`**, unlike `RenderObject`'s `width`/`height`/`flexGrow`
   handlers. Driving relayout via `alignItems` therefore left the dirty list empty
   and `flushLayout()` returned instantly — reported as 0.05 ms for 500 rows in
   Chrome, which reads as a fast Yoga rather than a no-op. Relayout is now driven
   through `width`, and each row asserts the reflow landed.

   That second gate was itself too weak at first: it compared the row's width
   against a value that happened to equal the row's natural content width, so a
   no-op passed it. Sabotage caught that too. **An assertion whose expected value
   coincides with the system's default state cannot distinguish "did the work"
   from "did nothing."**

Both VectoJS arms are tens of microseconds, which is at or below
`performance.now()`'s resolution — 5 µs in Chrome, **20 µs in Firefox**, even with
COOP/COEP. Timed one call at a time, the Firefox relayout produced
`[0.02, 0.02, 0, 0.02, 0, …]`: one timer tick or zero, a quantisation pattern
rather than a measurement, which also explains an earlier build "result" that got
_faster_ from 200 to 500 rows. Each arm's repetition count is now calibrated from
a probe call to fill a ~20 ms window, and the raw per-call samples ship in the
JSON so the calibration is auditable.

## `stream-markdown-smd` — vs [`streaming-markdown`](https://github.com/thetarnav/streaming-markdown)

**This one is a loss, and the biggest one recorded here.** `smd` (0.2.15, zero
dependencies, ~1.6k lines) is a true incremental parser: `parser_write(p, chunk)`
advances a persistent state machine over a flat `Uint32Array` token stack and
emits through a four-callback renderer interface, so it never revisits text it
has already consumed. Our streaming path re-lexes the **entire accumulated
document** on every chunk.

### Scope difference (ground rule 3)

`smd` is a parser and nothing else — no layout, no rendering beyond an optional
DOM renderer, no math, no accessibility, and a deliberately reduced CommonMark
subset. `@vectojs/markdown` parses **and** lays out **and** renders to canvas
**and** projects a semantic DOM mirror for screen readers **and** shapes TeX via
MathJax. Only the streaming-parse axis is compared, because that is the only
place the two genuinely overlap.

### The comparison is not "our parser vs theirs" — we don't have a parser

`lexMarkdown()` (`packages/markdown/src/Markdown.ts:42`) is a thin wrapper over
`marked.lexer()`, and `marked` is a real runtime dependency. Benchmarking "our
parser" against `smd` would be benchmarking `marked` against `smd`: two
third-party libraries, neither of them ours. What **is** ours is the strategy in
`MarkdownWorkerSource` — cache the accumulated source, append the delta, re-lex
the whole thing, return only the changed token tail via a raw-string prefix
match. That strategy is what this suite measures.

### Results

Real Chrome 150 / Firefox 153, COOP+COEP isolated, median of 9 trials after 3
warmups, 32-char chunks, both arms driven through an identical counting sink so
neither pays for rendering.

| Document (200 sections, 25 070 chars, 784 chunks) | Chrome | Firefox |
| --- | --- | --- |
| `smd`, whole stream | 0.76 ms | 1.08 ms |
| our strategy, whole stream | 434.3 ms | 443.8 ms |
| **ratio** | **571×** | **411×** |
| per chunk: `smd` | 0.97 µs | 1.38 µs |
| per chunk: ours | 554.0 µs | 566.1 µs |
| one full `marked.lexer()` of the finished doc | 0.975 ms | 1.020 ms |

The last row is the finding. Lexing the finished document **once** costs about a
millisecond; streaming that same document costs 434 ms. That is ~445× of pure
re-work — not a parser being slow, but the same linear parser being run 784
times over an ever-growing prefix.

### Scaling exponents, measured across 3 070 → 25 070 chars

| Arm                             | Chrome | Firefox |
| ------------------------------- | ------ | ------- |
| `smd`                           | 0.56   | 0.35    |
| our streaming strategy          | 2.01   | 1.84    |
| single `marked.lexer()` call    | 0.98   | 0.95    |

`marked.lexer()` is **linear** (0.98 / 0.95). The quadratic behaviour is entirely
ours, and it follows arithmetically: N chunks × O(document) per chunk. Measured
cost lands at 0.33–0.70 of `chunks × (cost of lexing the full document)` across
both engines and all four sizes, straddling the 0.5 that an exact O(n²)/2 would
give — early chunks lex a shorter prefix.

At small documents the gap is modest (25 sections: 27× Chrome, 18× Firefox). It
widens with length, which is exactly the wrong direction for a chat transcript
that grows all session.

### What the delta protocol does and does not buy

Token-prefix reuse is **99.5%** at 200 sections. The protocol works: it saves
almost all of the canvas entity rebuilds, which is what it was designed for. It
cannot save lexing, because the prefix match happens _after_ `marked.lexer()` has
already run on the full source. The win and the loss are in different phases.

The production path also runs this in a Worker, so an app's main thread does not
block on it. That is a real mitigation for responsiveness and not for cost: the
CPU work, the battery drain, and the final chunk's latency are unchanged.

### TODO (ground rule 5)

Lex only from the last **stable block boundary** rather than from the start of
the document. Markdown blocks are separated by blank lines, and a blank line
followed by already-stable tokens cannot be re-opened by later text, so the
prefix before it never needs re-lexing. That converts the stream from O(n²) to
O(n · block) without giving up the existing token-diff machinery. Fenced code
blocks and tables need care — an unterminated fence swallows everything after it,
so the boundary must be the last blank line _outside_ any open construct.

## Libraries reviewed but not yet benchmarked

Cloned into the workspace-root `references/` for source review: `pixijs`, `konva`, `fabric`,
`paperjs`, `twojs`, `zimjs`, `deckgl`, `perspective`,
`danmaku`.

`LightningChart JS` is commercial and closed-source — any comparison must be
based on its published documentation and labelled as such.

Note that for the **rendering** libraries (Pixi/Konva/Fabric/Paper/Two/ZIM), a
throughput number alone is misleading: the meaningful differences are text
crispness at DPR > 1, whether text is selectable, and whether an accessibility
tree exists at all. Those need real-browser screenshots (`grim`) and DOM probes,
not just timers — see the `hyprland-browser-bench` skill.
