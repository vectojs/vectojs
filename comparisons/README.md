
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
`tmp/references/` — read their actual implementation before writing a comparison.

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

## Libraries reviewed but not yet benchmarked

Cloned into `tmp/references/` for source review: `pixijs`, `konva`, `fabric`,
`paperjs`, `twojs`, `zimjs`, `deckgl`, `perspective`, `alibaba-canvas-ui`,
`danmaku`, `streaming-markdown`.

`LightningChart JS` is commercial and closed-source — any comparison must be
based on its published documentation and labelled as such.

Note that for the **rendering** libraries (Pixi/Konva/Fabric/Paper/Two/ZIM), a
throughput number alone is misleading: the meaningful differences are text
crispness at DPR > 1, whether text is selectable, and whether an accessibility
tree exists at all. Those need real-browser screenshots (`grim`) and DOM probes,
not just timers — see the `hyprland-browser-bench` skill.
