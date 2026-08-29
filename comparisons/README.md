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

## `stream-markdown-smd` — vs `streaming-markdown`, `streamdown`, `markstream-vue`, `incremark`, `react-markdown`, `@ant-design/x-markdown`

Seven streaming strategies in one suite, on one page, in one run:
[`smd`](https://github.com/thetarnav/streaming-markdown) (a true incremental
parser), [`streamdown`](https://github.com/vercel/streamdown) (Vercel's
AI-chat Markdown renderer), the parser behind
[`markstream-vue`](https://github.com/BuptStEve/markstream-vue) (published
standalone as `stream-markdown-parser`), `@incremark/core` (an incremental
parser built for AI streaming), `react-markdown` (React's most common Markdown
renderer), `@ant-design/x-markdown` (Ant Design X's AI-chat streaming
renderer), and both of our own strategies.

**Against `smd` this is still a loss, but no longer the biggest one recorded
here — it was 571× and is now 8.0×.** `smd` (0.2.15, zero dependencies, ~1.6k
lines) advances a persistent state machine over a flat `Uint32Array` token stack
and emits through a four-callback renderer interface, so it never revisits text it
has already consumed. Our streaming path used to re-lex the **entire accumulated
document** on every chunk; it now re-lexes only the text after the last stable
block boundary.

### Scope difference (ground rule 3)

`smd` is a parser and nothing else — no layout, no rendering beyond an optional
DOM renderer, no math, no accessibility, and a deliberately reduced CommonMark
subset. `@vectojs/markdown` parses **and** lays out **and** renders to canvas
**and** projects a semantic DOM mirror for screen readers **and** shapes TeX via
MathJax. Only the streaming-parse axis is compared, because that is the only
place the two genuinely overlap.

The five later arms are narrower still, and each is measured at the boundary where
it genuinely overlaps with us:

- **`streamdown`** is a React renderer. Its per-block `remark`/React stage is
  memoised per block and therefore already incremental, so benchmarking it would
  be benchmarking React. What is **not** incremental is the stage ahead of it:
  `remend()` repairs unterminated syntax and `parseMarkdownIntoBlocks()` splits
  the document into blocks, both over the whole accumulated text on every chunk.
  That is the stage this suite measures.
- **`markstream-vue`**'s parser has no Vue dependency at all once extracted, so
  the arm imports `stream-markdown-parser` directly and no framework work is in
  the timing. It returns a full node structure where our arm returns tokens — an
  asymmetry stated in the results rather than hidden, per ground rule 4.
- **`incremark`** (`@incremark/core` 0.3.10) is an incremental parser built for
  AI streaming, on a `marked` engine like ours. Measured at its public API: a
  persistent parser driven by `append()` once per chunk, closed with
  `finalize()`. Its `append()` re-parses the stable region between the last
  boundary and the current one, so it sits in the same stable-boundary strategy
  class as our `incrementalLex` and markstream's parser; the definition maps and
  AST rebuilds it returns on every call are part of what is measured.
- **`react-markdown`** 10.1.0 is the most common choice for rendering Markdown
  in React. It has no separable parser export and no cross-render cache, so the
  arm calls its synchronous `Markdown` component function directly, once per
  chunk over the accumulated document: remark re-parses the whole text and
  converts hast to React elements inside the timed region, while React
  reconciliation and DOM commit stay outside, exactly as our entity building
  does.
- **`x-markdown`** (`@ant-design/x-markdown` 2.9.0, Ant Design X) is an AI-chat
  streaming renderer whose `useStreaming` hook is genuinely incremental — a
  per-character recognizer caches completed syntax — but whose component then
  re-runs a full `marked` parse → HTML → sanitisation → element construction on
  every chunk. The arm renders the real component per chunk through `flushSync`
  into a detached container, so both stages sit inside the timed region; the
  React scheduling constant that adds is stated here rather than subtracted,
  per ground rule 4.

Every third-party arm is gated on producing the same output streamed as it does
in one shot before any timing is taken (`streamdownMatchesOneShot`,
`markstreamMatchesOneShot`, `incremarkMatchesOneShot`,
`reactMarkdownMatchesOneShot`, `xmarkdownMatchesOneShot`), and all thirteen
gates pass in both engines.

All marked-based arms — `vecto`, the `wholeDocument` control, `streamdown`,
`incremark`, `x-markdown` — lex through the **same** workspace copy of `marked`,
aliased at bundle time to `packages/markdown`'s pinned copy, so engine constant
factors cannot masquerade as strategy differences. `react-markdown` runs
micromark/remark instead, which is exactly why it is included.

### Libraries excluded from this suite

Two libraries under `references/markdown/` cannot run this axis and are excluded
with a reason rather than silently dropped:

- **`FluidMarkdown`** — native iOS/Android/HarmonyOS implementation with no
  browser runtime, so there is nothing for the streaming-parse axis to run.
- **`react-native-streamdown`** — a React Native port of streamdown; its web
  twin `streamdown` is already measured above, and driving the port through
  `react-native-web` would change what is being measured.

### The comparison is not "our parser vs theirs" — we don't have a parser

`lexMarkdown()` (`packages/markdown/src/Markdown.ts:42`) is a thin wrapper over
`marked.lexer()`, and `marked` is a real runtime dependency. Benchmarking "our
parser" against `smd` would be benchmarking `marked` against `smd`: two
third-party libraries, neither of them ours. What **is** ours is the strategy, and
the suite measures both of ours in the same process on the same hardware as the
six third-party arms:

- **`wholeDocument`** — the original: cache the accumulated source, append the
  delta, re-lex the whole thing, return only the changed token tail via a
  raw-string prefix match. Kept as a control arm so the before/after is a real
  measurement rather than a comparison against a number from another day.
- **`vecto`** — the current: `incrementalLex` tracks the last stable block
  boundary and lexes only what follows it. The arm imports the shipped package
  source rather than reimplementing it, so it cannot drift from production.

### Results

Real Chrome 151 / Firefox 154, COOP+COEP isolated, median of 9 trials after 3
warmups, 32-char chunks, every arm driven through an identical counting sink so
none pays for rendering. All thirteen gates pass in both engines. A second full
Chrome pass on the same commit reproduced every exponent family; its medians are
archived alongside as `-i2` and the drift is reported below.

| Document (200 sections, 25 070 chars, 784 chunks)       | Chrome      | Firefox      |
| ------------------------------------------------------- | ----------- | ------------ |
| `smd`, whole stream                                     | 0.86 ms     | 1.14 ms      |
| **ours, current** (stable block boundary)               | **6.91 ms** | **10.60 ms** |
| ours **before** (whole-document re-lex, control)        | 487.5 ms    | 461.8 ms     |
| `incremark` (`@incremark/core` 0.3.10)                  | 12.62 ms    | 12.02 ms     |
| `markstream` (`stream-markdown-parser` 1.2.0)           | 1048.5 ms   | 481.2 ms     |
| `@ant-design/x-markdown` 2.9.0 (component per chunk)    | 10329.7 ms  | 6383.6 ms    |
| `react-markdown` 10.1.0 (sync component call per chunk) | 16220.7 ms  | 8758.7 ms    |
| `streamdown` 2.5.0 (`remend` + block split)             | 5654.6 ms   | 5014.8 ms    |
| — of which `remend` alone                               | 5162.5 ms   | 4512.4 ms    |
| one full `marked.lexer()` of the finished doc           | 2.06 ms     | 1.38 ms      |

Our own before/after is **70.6× in Chrome, 43.6× in Firefox**, and the remaining
gap to `smd` is **8.0× / 9.3×**. The last row used to be the finding: lexing the
finished document once cost about a millisecond while streaming it cost 434 ms,
i.e. ~445× of pure re-work. That re-work is what the boundary removes. The
streamed cost is now **3.4× a single full lex** in Chrome (7.7× in Firefox),
against 439× before.

_Repeatability:_ a second Chrome pass under visibly heavier co-tenant load moved
the sub-millisecond arms up to +86 % and the control arm up to +66 %, while the
three heaviest arms stayed within −4.4 %…+24 %. Every exponent family reproduced.
Both passes are archived (`cmp-stream-markdown-smd-chrome151-2026-08-23-i{1,2}.json`,
Firefox as `cmp-stream-markdown-smd-firefox154-2026-08-23.json`); quoted figures
are the quieter first pass.

### The control arm is a faithful model of the competing strategy

This is the finding the two new arms existed to produce, and it matters more than
any ratio above. Our `wholeDocument` arm is something we wrote ourselves to
represent the strategy we moved away from, which makes it exactly the kind of arm
a reader should distrust — a straw man is easy to build by accident.

`streamdown` is that same strategy, shipped and in production. Subtracting its
`remend` time to isolate the comparable work:

| Sections                                  | 25    | 50    | 100   | 200   |
| ----------------------------------------- | ----- | ----- | ----- | ----- |
| streamdown − remend ÷ our control, Chrome | 0.89× | 1.02× | 1.09× | 1.01× |
| the same, Firefox                         | 1.04× | 1.01× | 1.08× | 1.09× |

Within 0.9–1.1× at every size in both engines (second Chrome pass: 0.74–1.09×,
the control arm being the noisier side under load), and on the same exponent
family (2.31 vs our control's 1.64 in the quoted pass; 2.58 vs 1.94 in Firefox;
across both Chrome passes the pair moved together). Characters fed to the lexer
agree independently: 9 850 405 for streamdown against 9 847 040 for our control
at 200 sections, a 0.03% difference from its slightly different block splitting.
So the before/after this suite publishes is measured against a faithful model of
what a real competitor does, not against a weakened stand-in.

### Scaling exponents, measured across 3 070 → 25 070 chars

| Arm                                            | Chrome | Firefox |
| ---------------------------------------------- | ------ | ------- |
| `smd`                                          | 0.37   | 0.32    |
| ours **before** (control)                      | 1.64   | 1.94    |
| ours **after**                                 | 0.79   | 1.19    |
| `incremark`                                    | 0.68   | 0.98    |
| `markstream`                                   | 1.75   | 1.69    |
| `@ant-design/x-markdown`                       | 1.67   | 1.90    |
| `react-markdown`                               | 2.00   | 1.96    |
| `streamdown`                                   | 2.31   | 2.58    |
| `streamdown`, `remend` alone                   | 2.45   | 2.75    |
| single `marked.lexer()` call                   | 0.92   | 0.87    |
| ours, characters handed to the lexer           | 1.00   | 1.00    |
| `markstream`, characters handed to its lexer   | 1.00   | 1.00    |
| `incremark`, characters handed to its lexer    | 1.00   | 1.00    |
| `streamdown`, characters handed to its lexer   | 1.99   | 1.99    |
| `x-markdown`, characters handed to marked      | 2.00   | 2.00    |
| `react-markdown`, characters through micromark | 2.00   | 2.00    |

**The exponent is the substance, not the ratio.** `marked.lexer()` is linear, and
the old strategy's ~1.9–2.0 was arithmetic: N chunks × O(document) per chunk. The
boundary brings our arm back to the parser's own complexity class, which is why
the improvement grows with length — 9.6× at 25 sections, 70.6× at 200 in the
quoted pass. The former "widens with length, exactly the wrong direction for a
chat transcript" now runs the right way.

The characters-fed rows are the mechanism, measured independently of wall time and
at each library's **real tokenizer entry point** rather than its public API. Ours
fall from **9 847 040 to 63 806** (154×) at an exponent of 1.00. Wall time can
move for incidental reasons; wall time and characters-lexed agreeing is what makes
the attribution sound.

### Three AI-chat renderers, three different answers

The arms added since the suite first ran are all renderers built for the same
job — streaming an LLM answer into a chat bubble — and they land in three
different places on the axis this suite measures:

- **`incremark` is boundary-class, like us and `markstream`.** Its lexer sees only
  **63 575 characters** across the whole stream against our 63 806 — it also
  re-tokenizes just the unstable tail after its last stable boundary, and the
  character counts agree with ours to 0.4 %. The wall-clock cost of that class is
  **12.62 ms / 12.02 ms** (Chrome/Firefox), i.e. **1.83× our arm in Chrome but
  only 1.13× in Firefox**, at a wall-time exponent that brackets linear
  (0.68–0.98) over characters-fed at exactly 1.000. The constant-factor overhead
  over our arm is bookkeeping, not tokenizing: every `append()` rebuilds its
  definition maps and re-splices the aggregate AST across _all_ completed blocks,
  work that grows with the document even though lexing does not.
- **`react-markdown` has no streaming strategy at all.** Every chunk re-runs the
  full remark pipeline over the accumulated document — micromark sees the entire
  prefix each time (**9 847 040 characters**, arithmetic prefix-sums confirmed),
  exponent 2.00 / 1.96, and at 200 sections it is the slowest arm measured:
  **16.2 s in Chrome**. It is markedly cheaper in Firefox (**8.8 s**) — the same
  engine divergence direction `markstream` shows, stated rather than averaged
  away. Scope: driven as a direct synchronous component call, so element-tree
  construction is included and React commit/DOM is outside the measured region,
  exactly where our canvas/entity work sits for our own arm.
- **`@ant-design/x-markdown` is genuinely incremental — everywhere except where
  it matters most.** Its `useStreaming` cache advances a per-character state
  machine over just the new chunk. But every update then feeds the completed
  string through a fresh `marked` parse to HTML plus a sanitiser: across the
  stream marked receives **9 843 357 characters, 99.96 % of the theoretical
  whole-document maximum**, at an exponent of 2.00 in both engines, which drags
  the wall clock to **10.3 s / 6.4 s** (exponent 1.67 / 1.90). Driven as the real
  published component per chunk via `flushSync`; the React scheduling constant
  that this adds is included in the number and stated per ground rule 4.

All three gates hold in both engines (`incremarkMatchesOneShot`,
`reactMarkdownMatchesOneShot`, `xmarkdownMatchesOneShot`): each library's final
streamed state is identical to what a one-shot pass over the finished document
produces, so no fast number below is buying its speed with a broken parse.

### `markstream-vue` converged on the same strategy we did

Its tokenizer character counts are **byte-identical to ours** at all four sizes —
7 776 / 15 582 / 31 242 / 63 806 — and the per-chunk sequences match element for
element, **0 differences across 96 chunks**. Two projects independently arrived at
re-lexing from the last stable block boundary. `markdown-it-ts`'s `StreamParser`
reports `{total: 96, tailHits: 95, fullParses: 1}` on the same stream.

This corrects an earlier note in our own backlog that described it as "a separate
`markdown-it` with no incremental API". Measuring its public API is what produces
that reading: `md.stream.parse` receives the whole accumulated document (392.8× the
document at 200 sections) and only re-tokenizes a tail internally. The real entry
point is `md.block.parse(src, …)`, where `src` is the tail — 32, 50, 82 chars on
the first three calls.

**Where it still costs 152× (Chrome) / 45× (Firefox) against our arm** is the
other half of the call: `parseMarkdownToStructure` rebuilds and returns the
**entire node array** on every chunk. Summed across the stream that is 158 907
nodes returned for a final 400 (397×), against 2 523 for a final 50 (50.5×). The
caller pays O(nodes) per chunk no matter how little was re-tokenized, which is why
a linear tokenizer still yields a 1.69–1.75 wall-time exponent. Note it is
**faster in Firefox than in Chrome** while ours is the reverse — opposite engine
preferences, worth stating rather than averaging away.

### `streamdown`'s cost is 89–91% `remend`, and that is an upstream bug

`remend` is 5162.5 ms of streamdown's 5654.6 ms in Chrome (91.3%) and 4512.4 of
5014.8 in Firefox (90.0%), at an exponent of 2.45–2.75 — worse than the
whole-document
lexing it sits in front of. We traced this to a quadratic scan in
`packages/remend/src/link-image-handler.ts:153`: for every `[` in the text it
calls `isInsideCodeBlock(text, i)`, which itself rescans `0..i`. Removing
`[…](…)` links from the corpus drops the exponent to 1.02 and the 400-section
cost from 75.7 ms to 1.44 ms (52×).

`isInsideCodeBlock` is a fold over the prefix, so a single left-to-right
`Uint8Array` prefix table replaces the rescan: **495× faster** (0.168 ms at 400
sections), exponent 0.959, agreeing with the original at every one of 4 096
positions checked. Written up in
`vectojs-docs/forge/findings/upstream/README.md` with the reproduction; not yet
filed upstream.

**This is a feature gap, not just a win.** `remend` closes unterminated syntax
mid-stream, so a half-typed `**bold` renders as bold text rather than as literal
asterisks that reflow a moment later. `@vectojs/markdown` has **no counterpart**
— we render the partial token as-is. That is a real capability we lack, and it
is the reason streamdown pays this cost at all; it is deliberately excluded from
the perf axis rather than counted as a defeat for them.

### What the delta protocol does and does not buy

Token-prefix reuse is **99.5%** at 200 sections, and always was. The protocol
works: it saves almost all of the canvas entity rebuilds, which is what it was
designed for. It never could save lexing, because the prefix match happens _after_
`marked.lexer()` has run — the win and the loss were in different phases, and the
fix had to be additive rather than a redesign of the diff.

The production path also runs this in a Worker, so an app's main thread does not
block on it. That was a real mitigation for responsiveness and not for cost: CPU
work, battery drain, and the final chunk's latency were unchanged, which is why
this was worth fixing despite the Worker.

### Two document shapes deliberately keep the old cost

Correctness comes first here: a boundary placed one line early corrupts the token
stream rather than merely being slow. Two constructs let appended text change
tokens already emitted, so an instance containing either degrades to
whole-document lexing — measured at parity (1.01×) with the old strategy, never
worse:

- **Link reference definitions.** `marked` collects every `def` while block-lexing
  and only then resolves reference links across the whole document, so a
  definition arriving late retroactively rewrites inline tokens already emitted,
  and one inside the stable prefix is invisible to a suffix lex.
- **Display math (`$$`).** Our own `blockMath` extension breaks locality in both
  directions. Forwards: its `[\s\S]+?` tokenizer crosses blank lines, so an
  unterminated `$$` swallows following tokens — measured,
  `'$$\nopen\n\npara\n'` is `[paragraph, space, paragraph]` and appending
  `'\n$$\n'` collapses all three into one `blockMath`. Backwards: marked's
  `startBlock` clip, which the extension's `start()` hook triggers, merges a
  following paragraph into a preceding one, so a `$$` anywhere ahead re-groups
  paragraphs already banked.

The `degraded` field on each result row reports which path ran, so a timing figure
from this suite always says whether the boundary was in play.

### TODO (ground rule 5)

Make display math incremental by stopping `blockMath`'s tokenizer at a blank line,
which would remove the larger of the two degrade paths. That is a rendering
behaviour change for existing content and affects `Markdown.ts` equally, so it
belongs in its own task rather than riding along with a performance fix.

Closing the remaining 8.0× would mean not calling `marked` at all — `smd`'s design
advantage is that it never re-tokenizes a partial block, whereas we re-lex the
unstable tail from its start on every chunk. That is a genuine architectural
difference and not obviously worth the cost of owning a CommonMark parser.

Mid-stream syntax repair (`remend`'s job) is the one capability in this comparison
that we lack outright. Worth having; worth implementing as a prefix-table pass
from the start rather than as a rescan per delimiter.

### Long-session streaming: 100KB / 500KB / 1MB — heap, entities, charsLexed/Shaped, layout visits

A streaming Markdown document that grows to 1 MB is not a bigger version of a 25 KB chat bubble — it is where a quadratic pipeline becomes unusable. This bench streams the same synthetic corpus used by `markdown-retained-stream` (heading + paragraph + blockquote + list + table + code per section, unique per index) to **100 KB, 500 KB and 1 024 KB**, in **320-char chunks**, and measures the five costs that matter for a long session:

- **heap** — `process.memoryUsage().heapUsed` headless, `performance.memory.usedJSHeapSize` / `measureUserAgentSpecificMemory` in the browser (quantized to 5 MB without `--enable-precise-memory-info`, source reported alongside the figure)
- **worker retained source** — `rawMarkdown.length` (the worker keeps the same string via `workerSourceLen`; `workerSourceLen === rawChars` when incremental)
- **entity count** — top-level `content.children.length` and total entities via tree walk
- **nodes created/destroyed** — `streamStats.entitiesRebuilt` / `entitiesReused` / `inPlaceUpdates` and `tokensPrefixMatched` / `tokensReturned`
- **charsLexed** — `sourceCharsLexed` from incrementalLex (the shipped worker tail) vs the whole-document control
- **charsShaped** — total characters passed to `CanvasRenderingContext2D.measureText` (headless stub counts `text.length`, browser counts real `measureText` calls)
- **layout visits** — `Stack.layout()` invocations plus `Scene` phase totals (`transform`, `drawWalk`, `entityPaint`, etc. via `beginPhaseCapture`)

Headless run (`bun run comparisons/stream-markdown-smd/long-session-bench.ts`, 5 trials median, 1 warmup) — the browser twin lives at `benchmarks/markdown-long-session` (Scene + Markdown + real canvas, heap via `heapBytes()` like `hybrid-projection`):

| doc | chunks | heap headless Δ / after | entities top / total | charsLexed inc / whole (ratio) | charsShaped | layout visits (Stack) | time inc / whole |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 100 KB (102 400) | 320 | 0.00 / 6.16 MB | 767 / 2 301 | 131 481 / 16 435 200 (125×) | 131 481 | 2 301 | 21.35 ms / 2 868 ms (134×) |
| 500 KB (512 000) | 1 600 | 2.74 / 17.63 MB | 3 801 / 11 403 | 693 236 / 409 856 000 (591×) | 693 236 | 11 403 | 133.07 ms / 71 704 ms (538×) |
| 1 024 KB (1 048 576) | 3 277 | −6.38 / 24.37 MB* | 7 754 / 23 262 | 1 429 829 / 1 718 720 960 (1 202×) | 1 429 829 | 23 262 | 329.15 ms / 300 750 ms (913×) |

\* Headless `heapDelta` is `heapAfter - heapBefore` per trial median; the −6.38 MB at 1 MB is GC (heapBefore 30.75 → heapAfter 24.37 after `global.gc()`), not a leak — `heapAfter` itself grows monotonically 6.16 → 17.63 → 24.37 MB.

Scaling exponents across 100 → 1 024 KB (10.24× chars):

| metric | exponent | interpretation |
| --- | --- | --- |
| `incrementalCharsLexed` | **1.03** | linear — stable boundary skips re-lexing |
| `wholeDocumentCharsLexed` | **2.00** | quadratic control — `Σ prefix` |
| `incrementalMs` | **1.18** | near-linear wall time (lex + reconcile) |
| `wholeMs` | **2.00** | quadratic wall time |
| `entityTotal` | **0.99** | linear — one entity per block, reused |
| `charsShaped` | **1.03** | linear — each char measured once |
| `layoutVisits` | **0.99** | linear — one `Stack.layout` per entity |

**Pipeline stays linear.** Characters handed to the lexer grow 10.24× → 10.87× (1.03 exponent), entities 10.11×, layout visits 10.11×, and wall time 10.24× → 15.41× (1.18) — all O(n). The whole-document control that re-lexes the accumulated source each chunk grows 104.59× in chars (2.00) and 104.85× in time. The gap widens from 125× at 100 KB to 1 202× at 1 MB, which is exactly the wrong direction for a chat transcript if the control were shipped.

Heap and worker retention are also linear: `heapAfter` 6.16 → 24.37 MB (3.95× over 10.24× chars, but per-char 0.06 B → 0.023 B, not growing superlinearly; delta is noisy due to GC buckets), `workerRetainedChars` equals `rawChars` at every size (no duplication).

Nodes created/destroyed: `entitiesReused` tracks `tokensPrefixMatched` (99%+ reuse, same as `stream-markdown-smd`'s 99.5%), `entitiesRebuilt` equals `tokensReturned` (the changed tail), `inPlaceUpdates` fires for code/paragraph/heading/list/table/image tails — so per-chunk work is O(tail), not O(document).

Results: `comparisons/stream-markdown-smd/results/long-session-2026-08-28.json` (also `long-session-latest.json`); browser run writes `benchmarks/markdown-long-session/results/history/markdown-long-session-<engine>-<runId>.json` via `reportResult`. Run: `bun run comparisons/stream-markdown-smd/long-session-bench.ts` (headless, also shows the 122×–913× speedups) or `benchmarks/run-browsers.sh markdown-long-session 8179 chrome firefox` (headed, real heap via `measureUserAgentSpecificMemory` and real `measureText`/`fillText` counts).

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
