---
title: "05 — Zero-DOM TeX — Typesetting & SVG Emission"
description: "Why KaTeX kernel → VectoJS emitter → self-contained SVG, the coordinate-space invariants, stretchy geometry pitfalls, and the safe path to a new TeX construct."
order: 25
---

# 05 — Zero-DOM TeX — Typesetting & SVG Emission

> **Boss 05** owns the contract that turns a TeX string into a self-contained SVG without any browser — no DOM, no CSS engine, no webfonts — and that keeps every box, clip, and stretchy glyph geometrically faithful to what KaTeX would have rendered in a browser.
>
> - **What you will learn**: why KaTeX is vendored as a layout kernel and where the browser's job ends; the span-tree → SVG emission pipeline; the five coordinate/transform spaces where a single wrong frame breaks every stretchy; the historical bug cluster that maps directly onto those spaces; and the safe way to add a new TeX construct.
> - **What you will not**: Unicode/BiDi, Arabic shaping, or `LayoutEngine` line-breaking — boss 02 owns those; Markdown worker transport and streaming reconcile — boss 04; `GlyphRasterAtlas`/`SVGRasterCache` DPR paths — boss 07; the `IRenderer` contract itself.

## Why Zero-DOM TeX exists

KaTeX's own `buildHTML` (`packages/tex/src/kernel/VENDORED.md`) emits a span tree whose geometry depends on two external engines: **CSS layout** (`position: relative` + `top`, `display: table-cell` + `vertical-align`) for vertical placement, **inline text layout** for x, and **webfont resolution** (CSS class → font file → glyph) for ink. `@vectojs/markdown` cannot pay any of those: an `SVGEntity` rasterises via `data URI → Image → createImageBitmap → drawImage` (`packages/tex/src/index.ts:8`). An `Image` loaded from a data URI resolves no external URLs and inherits no page CSS, so neither KaTeX's HTML/CSS output nor any webfont-based approach survives the trip. The SVG must carry **its own outlines**.

The result is a hard constraint: the emitted SVG carries zero external references — no `<text>`, no `font-family`, no `url()`, no `xlink:href` (`packages/tex/src/emit/svg.ts:1` header). That constraint is what justifies a new package rather than a KaTeX configuration.

Size is the program budget that chose this shape over the alternatives (`vectojs-docs/forge/decisions/math-engine-2026-08.md:30`): a `bun build --splitting` decomposition of `mathjax-full@3.2.2` measured **84% of gzip in the SVG output + embedded fonts**, only ~16% in the TeX input layer, so the lever is a **glyph whitelist**, not package trimming. KaTeX was measured to have **no SVG output at all** (`src/kernel/Settings.ts:206` enum is exactly `["htmlAndMathml","html","mathml"]`), and a minimal RaTeX `wasm32` build measured **1 010 901 gzip / 768 278 brotli — 1.47× the MathJax chunk it would replace** (`math-engine-2026-08.md:103`), so WASM does not win the axis this work exists for.

## What is vendored and what is ours

`packages/tex/package.json:14` build order documents the split. `packages/tex/src/index.ts:25` is the map, with the contract lines to read rather than re-describe:

- `src/kernel/` — KaTeX (MIT), copied by `scripts/vendor-katex.ts` from a **pinned commit** (`references/markdown/KaTeX@5a5bf206`, `forge/decisions/math-engine-2026-08.md:191`) and mechanically stripped of MathML and DOM emission. **Not reformatted or lint-fixed**, so the files stay diffable against upstream. `VENDORED.md` names the kept and dropped sets; `.oxlintrc.json` and `tsconfig.build.json` both exclude the kernel for exactly this reason (`math-engine-2026-08.md:312` footnote).
- `src/registry/` — two hand-written files (`defineFunction`, `defineEnvironment`) no token-level transform can produce, because `mathmlBuilder` appears in expression position there (`src/index.ts:30`). Their `sideEffects:false` trap is what made Phase 1's bundle non-functional (`math-engine-2026-08.md:294` Correction 5), so `package.json` **must not** be `sideEffects:false` — import side effects populate `functions`/`environments` and tree-shaking would delete every builtin.
- `src/emit/` + `src/layout.ts` — ours, the only files the emit discussion touches.
- `src/glyphs/glyphs.subset.json` — TTF outlines → SVG paths via `scripts/generate-glyphs.ts`, narrowed by `scripts/subset-glyphs.ts`, re-encoded by `scripts/encode-glyphs.ts` + `src/emit/glyphCodec.ts` (Phase 2 binary format, `math-engine-2026-08.md:282`). The shipped runtime table decodes to **byte-identical** path strings to Phase 1's extractor (`glyphCodec.test.ts` identity assertion) and is **12.0% below a subset TTF of the same glyphs** (`math-engine-2026-08.md:328`).

## The pipeline — file map

```text
TeX string  ──►  layout(tex, opts)                         layout.ts:62
                 Settings(displayMode,maxSize,strict)  ·─► kernel/Settings.ts
                 parseTree → AST                       ·─► kernel/parseTree.ts + Parser.ts
                 buildHTML(tree, Options) → DomSpan    ·─► kernel/buildHTML.ts + buildCommon.ts:552 makeVList
                      │ height/depth/style.top already resolved
                      ▼
                 DomSpan tree                          layout.ts:84-89  (wrapped in vecto-tex root)
                      │
                      ▼
                 emitSVG(tree, {emPx,color,padEm})     emit/svg.ts:1567  EmitResult{svg,width,height,depth,missing,placements}
                   walk → EmitState{glyphs,rects,paths,lines}
                   viewBox = layout box ∪ ink union + pad
                   defs deduplication + grouped fills + clipPaths
                      │
                      ▼
                 MathRender{uri,widthEx,heightEx,depthEx}  markdown/src/markdown-math.ts:544 convertMathToSVGDataURI
                   bounded mathCache (256) + inlineMathRasters (LRU, 256)
                   lazy import via preloadMathJax()
                      │
                      ▼
                 InlineObject{width,height,depth,alt,paint}  markdown/src/markdown-inline.ts:287 inlineMath arm
                   InlineObjectBox in LayoutEngine lines, paint draws the raster
```text

`layout` (`layout.ts:62`) is KaTeX's `buildTree` without the `.katex`/`.katex-display` wrappers that carry browser-only CSS semantics (`layout.ts:5`). Its only interesting choice is `throwOnError:true` + `strict:false` (`layout.ts:68`): a hard parse error throws so the caller can degrade to showing TeX source verbatim (what `@vectojs/markdown` already does for unknown commands); a strictness violation does not.

`emit/svg.ts:1` does the three things the browser would otherwise have done, named in its own header because each has cost real bugs:

1. **Resolve glyph → outline.** `SymbolNode` carries text plus metrics but **not the font** (`fonts.ts:57` `CLASS_TO_FACE`). `\left(` yields a `SymbolNode` with an empty class list under a `delimsizing size1` ancestor — resolving locally would pick `Main-Regular` and draw a short paren where a tall one belongs (`math-engine-2026-08.md:444` measured: 105/105 correct via ancestor chain, 97/105 without; `svg.ts:427` `walk` `classChain` param).
2. **Accumulate x.** The span tree carries no x at all — only `functions/rule.ts:44` ever writes `Span.width`, and there it means a rectangle. Every other x is inline text layout, so the emitter sums per-glyph advances from the TTF `hmtx` table (`svg.ts:492` `getGlyph` + `advance`; `math-engine-2026-08.md:432` notes why `hmtx` not `fontMetricsData.width` — combining accents are 0 advance so a mark overlays its base, while metrics claims 1.0–2.33 em).
3. **Convert CSS vertical placement → explicit y.** `makeVList` encodes each row as `style.top = -pstrutSize - currPos - elem.depth` against a sibling `pstrut` of height `pstrutSize`; the conversion reads `pstrutSize` back out of the tree (`svg.ts:1029`) and uses `rowY = y - (-(top + pstrutSize)) * UPEM * scale` — it never re-derives KaTeX layout (`svg.ts:32`, `math-engine-2026-08.md:417` #1).

The emitter's unit is **1/1000 em** (`svg.ts:52` `UPEM`), matching both the glyph table's `UNITS_PER_EM` (`glyphTable.ts:49`) and `svgGeometry.ts`'s documented 1000:1 viewBox. `y` is **positive downward from the baseline**. Glyph outlines ship y-up, so each is placed inside `scale(1,-1)` rather than having its path rewritten (`svg.ts:1552` `transform` string; rewriting would cost precision and defeat dedup).

Markdown's wrapper (`markdown-math.ts`) then typesets through this pipeline **lazily**: `preloadMathJax` (`markdown-math.ts:85`, type-only `import type {emitSVG,layout}` at line 6 so a value import does not pull the engine into every consumer) dynamic-`import('@vectojs/tex')`, caches `MathRender` at 256 entries plus an LRU raster map at the same bound (`markdown-math.ts:218` `mathCache`, `markdown-math.ts:238` `inlineMathRasters`; `inlineMathRasters` unbounded was a P3 finding — `forge/findings/text-richtext-and-markdown.md:1924`), and emits inline math as an `InlineObject` with `width/height/depth` in px via `exToPx` (`markdown-math.ts:143`, `markdown-inline.ts:305`) and `paintInlineMath` (`markdown-math.ts:331`). Display math is a `MathBlock extends MarkdownContainer` (`markdown-math.ts:598`). Neither file holds a static value edge to `@vectojs/tex` — a second one (`KATEX_FONT_SCALE` was re-declared not imported in `markdown-math.ts:484` for this reason; equality is asserted in `test/mathBoxGeometry.test.ts`).

### Font resolution — the full chain

`fonts.ts:194` `resolveFont(classes)` scans the accumulated `classChain` through three maps in priority:

- `DELIM_SIZE_FONTS` (`fonts.ts:98` e.g. `delimsizing size1 → Size1-Regular`) — highest, because stretchy delimiters carry this on an ancestor, not the `SymbolNode`.
- `DIRECT_FONT_CLASSES` (`fonts.ts:120` e.g. `mathbb → AMS-Regular`, `mathcal → Caligraphic-Regular`).
- `CLASS_TO_FACE` (`fonts.ts:57` e.g. `mord textit → Main-Italic`, `mathbf → Main-Bold`) composed via `AVAILABLE` fallback (`fonts.ts:135` — if `Math-BoldItalic` absent, falls to `Math-Regular`).

Sizing is multiplicative through `SIZE_MULTIPLIERS` (`fonts.ts:263`, verified against `katex.scss $sizes` and `kernel/Options.ts sizeMultipliers` by the vendor drift guard — see § Vendor invariant guards) via `sizingRatio` (`fonts.ts:265`). Both the font and the scale are resolved from the **full** chain on every node, not just the leaf.

### Glyph table and hookup — one image

One `SymbolNode` → one outline: `walk` passes its `classChain` to `emitSymbol` (`svg.ts:427`), which resolves the font via `resolveFont`, looks up the outline via `getGlyph(font, code)` (`glyphTable.ts:73`, backing `GlyphTable` in `glyphCodec.ts:277`), and either pushes a `PlacedGlyph{x,y,scale,font,code}` (`svg.ts:132`) advancing by `glyph.advance/UNITS_PER_EM * UPEM * scale` (`svg.ts:499`), or — on a miss — records `font/U+XXXX` in `state.missing` (`svg.ts:500`) and advances by the vendored `getCharacterMetrics` width (`kernel/fontMetrics.ts`; superset of the shipped outlines, `svg.ts:505`). Repeating `SymbolNode.text` characters are **not** fused via `node.width` (`buildCommon.ts:296` `tryCombineChars` concatenates text while leaving `width` as the first character's) — each code point is measured individually, with a warned-once zero-advance fallback when both table and metrics miss (`svg.ts:514` `warnedMetricsMisses`, bounded `MAX_CACHED_MISSES = 1024` at `glyphCodec.ts:83`) so a bad glyph does not poison `penX`/`viewBox`.

## Coordinate-space invariant

Every placement travels through **five spaces** on one trip from a DOM class list to a final pixel in the SVG's `viewBox`. A bug at any one breaks all stretchy constructs at once, and the two real clusters that broke together did exactly that.

| #   | Space                           | Definition                                                                                               | Y direction                                                      | Scale                                                                                                             | Clip meaning                                                       | Where                                                                        |
| --- | ------------------------------- | -------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ | ---------------------------------------------------------------------------- |
| 1   | **Root-local (em)**             | `state.x` pen, `y` baseline, all `parseEm` lengths × `UPEM × scale`                                      | +down, baseline origin (`svg.ts:427` `walk` `y`)                 | `sizingRatio(classChain)` accumulated (`fonts.ts:265`)                                                            | —                                                                  | `emitContainer` + `emitSymbol` entry                                         |
| 2   | **Row-local (replay)**          | `vlist-t > vlist > vlist-r > row` with `rowY = y - above` (`svg.ts:1080`)                                | +down, vlist baseline                                            | same                                                                                                              | Row indent `dx = startX + indent + marginLeft`                     | `emitVList` probe + replay (`svg.ts:1031-1180`)                              |
| 3   | **Post-transform (path-local)** | `<path transform="translate(x,y) scale(sx,sy)">` maps local → root user space                            | svg user space, y-down outside `scale(1,-1)` per glyph           | glyph: `scale / -scale`; stretchy: `sx = scaleWidth/vbW, sy=heightEm/vbH` (`svg.ts:612`)                          | `viewBox` of width `400em` at `sx` → `scaleWidth`                  | `emitSvgNode` + final `body` transform strings (`svg.ts:584`, `svg.ts:1569`) |
| 4   | **ClipPath local**              | `<clipPath><rect>` resolved **after** the referencing element's transform (SVG `userSpaceOnUse` default) | **Post**-transform user space                                    | inverse: `invSx=1/sx,invSy=1/sy` (`svg.ts:1555`)                                                                  | **Must be emitted in the path's own frame**                        | `svg.ts:1550-1562` `clipPath` rect                                           |
| 5   | **Markdown box (ex/px)**        | `MathRender{widthEx,heightEx,depthEx}` then `exToPx(…,runSize)` → `InlineObjectBox`                      | LayoutEngine line box, baseline + depth (`markdown-math.ts:566`) | `EX_PER_KATEX_EM = KATEX_FONT_SCALE/EX_PER_EM` (`markdown-math.ts:514`, 0.02% verified vs real KaTeX in Chromium) | padded by `MATH_PAD_EM=0.05` (`markdown-math.ts:481`) on all sides | `markdown-math.ts:544` + `markdown-inline.ts:305`                            |

**The invariant** (what must hold on every path that emits a clipped or overlay branch): the `PlacedPath.clip` window is recorded in **root space** (`svg.ts:146-170`, `emitSvgNode` seeds it from `min-width`), translated by any `aligned-vlist` replay `dx` (`svg.ts:1196` `clip.x += dx`), then emitted after inverting by `sx/sy` (`svg.ts:1555`). An off-by-one space between 3 and 4 misplaces every radical and overbrace by `p.x + sx·clip.x` rather than `clip.x` (`CHANGELOG:31` #787).

## Stretchy geometry — the three families

A stretchy element's geometry is **not in `Span.width`**. Only `functions/rule.ts:44` ever writes that. Three families, three different coordinate facts — mixing them up is how the bugs happened.

### Ordinary glyphs and rules

- `PlacedGlyph.x` is an absolute root x; `width` is `advance/UPEM * scale`. No viewBox, no slice, no `clip`.
- `PlacedRect` is one of three shapes: a rule at `Span.width` (`svg.ts:903`), a full-width rule/border (`borderBottomWidth` / `.angl` / `\boxed` borders at `svg.ts:800` `fullWidth:true`, resolved by `placeRect` at `svg.ts:1256`), or a vertical separator (`vertical-separator` at `svg.ts:718` → stroked `PlacedLine`). Full-width shapes contribute **no advance** — `span.width` being absent is meaningful.

### Single-path hide-tail stretchies

`\sqrt` and `\phase` each emit one 400em-wide `SvgNode` under a wrapper whose CSS is `overflow:hidden` (`hide-tail` at `katex.scss:513`).

- `\sqrt`: wrapper writes **inline** `style.minWidth = 0.853em` (`kernel/delimiter.ts:533`), which `emitContainer` reads at `svg.ts:969` `clipEm = parseEm(style.minWidth) || parseEm(style.width)`. So `emitSvgNode` seeds `state.x + clipEm*scale` as both `widthEm` and `clip.w` (`svg.ts:590`). The 400em path's `sx` uses `rawWidthEm` (not `widthEm`) so a `slice` renders at its declared scale and is trimmed, not squashed.
- `\phase`: wrapper writes **only `style.height`** (`kernel/functions/enclose.ts:60`). No inline `minWidth/width`, so `clipEm` stays `undefined` and `hideTail` is `unclippedHideTail === true` (`svg.ts:971`). The child is not advanced as 400em (`svg.ts:966` `emitOverlayPiece` with `FULL_WINDOW: 0..1 xMinYMin`). Instead the whole container extent is the clip (`markdown` analogue at `markdown-math.ts:92` is unrelated; the logic is `svg.ts:966`).

The subtlety: where `minWidth` **exists** the clip is seeded inline and `emitSvgNode` is correct; where it **does not** the clip is pending and must defer to the enclosing vlist extent (see #667 below). Two code paths for the same wrapper class.

### Multi-piece overlays

`\overbrace`/`\underbrace`/`\xleftrightarrow`/`\xrightarrow` split one 400em path across **2–3 spans** that are `position:absolute` percentage windows (`stretchy.ts:238` `widthClasses = brace-* / halfarrow-*`; CSS at `katex.scss:519`).

- Each piece's `SvgNode` again declares `width:"400em"` — taking it literally measured `\overbrace{x+y}` at **1200em** (3×400) (`CHANGELOG:31`).
- The pieces are recorded as **zero-advance** `PlacedPath.overlay:{start,end,align,vw,vh}` (`svg.ts:195`, `emitOverlayPiece` at `svg.ts:629`) and resolved only once the enclosing vlist row's `width` is known: uniform cover scale `s = max(boxW/vw, boxH/vh)`, per-piece `preserveAspectRatio` alignment (`xMinYMin / xMidYMin / xMaxYMin` at `svg.ts:1286` `placeOverlay`), window-clipped to `boxX = startX + start*width`.

## Five invariants the emitter must never break

These closed the batch and have since been the costliest way to regress:

1. **`classChain` carries the font.** A `SymbolNode` frequently has an empty class list; the font is on an ancestor. Local resolution silently draws a tall delimiter where a short one belongs and a short paren where a tall one belongs. Affects **all** delimited formulas (`fonts.ts` + `svg.ts:427` + `math-engine-2026-08.md:443` measurement).
2. **`state.x` is advance, not geometry.** `parseEm(margin*)/hmtx advance/sizingRatio` sum is the only correct x. Any second source double-counts.
3. **`top + pstrutSize` → `rowY` is the only vertical truth.** Read `pstrutSize` out of the tree; do not recompute it (`svg.ts:1029`).
4. **`clip`/`overlay` defer to the enclosing vlist extent; nothing else.** A full-width rule, a hide-tail radical, a `\cancel` overlay and a brace piece all resolve against **their own** enclosing row's `width` (`svg.ts:1172` `rectStart/lineStart/pathStart` + `svg.ts:1230`). Resolving against the formula's `state.x` misplaces `\cancel` diagonals by the preceding advance and buries nested socpe.
5. **`clipPath` rects are in path-local coordinates.** Emit `(clip.x - p.x)*invSx` (`svg.ts:1558`), never `clip.x` raw, and replay a recorded clip with the same `dx` as its path (`svg.ts:1196`). Space 4 ≠ space 3.

## Case studies — bugs as coordinates

Each is a distinct space-mixup, with line numbers at the fixed state.

### #787 — `clipPath` coordinate space (`svg.ts:1550-1562`, `CHANGELOG:31`)

`clipPathUnits` defaults to `userSpaceOnUse`, meaning the `<rect>` inside a `<clipPath>` is resolved **after** the referencing `<path>`'s `transform`. So the rect must be written in the path's own local frame. Before the fix, `svg.ts:1555` emitted root-space `clip.{x,w}` verbatim, so SVG applied `translate(p.x) ∘ scale(sx)` a second time: the window landed at `p.x + sx·clip.x`. Every clipped stretchy — `\sqrt`, every phase — disappeared off-canvas under a non-1 `sx`/`sy`. The same commit also added `svg.ts:1196` `clip.x += dx` on the aligned-vlist replay, because a clip is an absolute root-space window like the path it bounds — deferring the path but not its window broke `\frac{\sqrt{x}}{y}` when the radical sat in a centered numerator (`CHANGELOG:57` `svgClipWindows.test.ts`).

### #667 — `\phase` measured 400em (`svg.ts:966`, `CHANGELOG:56`)

`\sqrt` always writes inline `min-width` on its wrapper so `emitSvgNode` could clip immediately; `\phase` does not. The emitter trusted the SvgNode's declared `widthEm: 400` as the advance, reporting `\phase{-120}` at 400em. Fixed by detecting `classes.includes('hide-tail') && clipEm===undefined` as `unclippedHideTail` (`svg.ts:971`) and routing that branch to `emitOverlayPiece(FULL_WINDOW)` — a zero-advance overlay whose visible window is the enclosing row.

### #665 — `\overbrace` measured 800–1200em (`svg.ts:859`, `CHANGELOG:58`)

Same root cause, multi-piece: `brace-left/center/right` and `halfarrow-left/right` are `position:absolute` with `width:25/50/50%` of the enclosing row (`katex.scss:519`). Each `SvgNode` still declares 400em — adding them measured `\overbrace{x+y}` at 1200em. Fixed by recognising `OVERLAY_PIECES[class]` (`svg.ts:328`), treating those SvgNodes as zero-advance pending overlays (`emitOverlayPiece` at `svg.ts:867`), with `CONTAINER_BORDER_CLASSES` (`svg.ts:308`) for the related `.angl` case where the border lives only in CSS.

### #825 — `\sqrt{b^2-4ac}` rendered as `b²√4ac` (`svg.ts:1186`, `CHANGELOG:15`)

Two independent faults, both centered on the radicand width:

- `ROW_ALIGN_CLASSES.sqrt` was `center` instead of `left` (`svg.ts:266`). KaTeX has no `.sqrt {text-align}` rule; the initial is `left`. With `center`, the narrow 400em radical sat in the middle of a wide radicand, so the vinculum appeared to start to the right of the opening `b²`.
- The hide-tail clip was sized to `minWidth` only, never to the actual radicand width. Once `width` (the vlist extent, i.e. radicand width when wider) was known, `svg.ts:1186` expanded `p.w`/`p.clip.w` to `max(minWidth, radicandWidth)` — and only for the integer `vlist` body `classChain.includes('sqrt')`, not an ancestor (`svg.ts:1203` guard), otherwise an outer `mfrac` stretched the radical to the fraction width.

### #788 — pinned clip windows with non-1 scale and aligned replay (`svg.ts:1196`, `svgClipWindows.test.ts`)

The soundness claim on the aligned-vlist single-walk optimisation previously said "translation is sound because `walk` is affine in `state.x`" and claimed clip translation was sound **before** `svg.ts:1196` translated clips (`CHANGELOG:57`). The regression tests now assert from the **emitted SVG** that the effective rendered window coincides with the placed path's own box both under `sx=sy=0.7` and inside a replayed centered `\frac` numerator.

Plus the six 2026-08-13 P2/P3 findings the paragraph compresses but the emit code preserves as still-load-bearing guards (`forge/findings/text-richtext-and-markdown.md:1789`):

- **#514 phantom** — `style.color==="transparent"` (`kernel/Options.ts:306`) marks phantom ink (`buildCommon.ts:96`); skipping ink but keeping advances is at `svg.ts:479`/`svg.ts:744` (`phantom` flag).
- **#514 color** — TeX `\color` writes `style.color` on every node (`functions/color.ts`); the emitter inherits the effective color through `walk` and groups by it (`svg.ts:1522` `grouped`), with `escapeAttr` at `svg.ts:1542` hardening any user-derived string (`&`→`&amp;`, `"` etc.).
- **#514 rules/borders** — every `borderBottomWidth`/`katex-sout`/`.angl`/`.boxed` style becomes a `fullWidth` rect (`svg.ts:800`, `svg.ts:834`) rather than just `frac-line`.
- **#514 `op-limits`/`x-arrow`/`mover`/`munder` centering** — added to `ROW_ALIGN_CLASSES` (`svg.ts:266`) and verified against `katex.scss:405`/`563` so `\sum` limits and `\xrightarrow` labels land under the operator/arrow center.
- **#521 lap (`\llap`/`\clap`)** — CSS `right:0`/`margin-left:-50%` (`katex.scss:293`) implemented by measuring `lapWidth` and shifting `state.x` by `-lapWidth`/`-lapWidth/2` (`svg.ts:982` `lapKind` branch) rather than treating all three laps as `rlap`.
- **#521 `\smash`/viewBox** — `functions/smash.ts:66` zeroes a node's `height/depth` while children keep size; the emitter expands the viewBox to the **union** of placed ink (`svg.ts:1630` `minX/minY/maxX/maxY` union) rather than the layout box, so smashed content is not cut off.

### Glyph/table history that still constrains the emit contract

- **Missing glyphs as blank ink** (`CHANGELOG:62` `ff79c58`): the `569→662 (+87)` subset addition for `U+2248`/`h*`/`l*` etc. — missing outlines advanced correctly via metrics so they rendered as **correct-width blank gaps**, invisible but layout-correct.
- **Display-variant whitespace holes** (`CHANGELOG:9` set `U+2216`,`U+22C3` display variant, `U+005F`, overline test block): display blocks **downgraded to raw TeX source** (blue CodeBlock) instead of typesetting, because `convertMathToSVGDataURI` at `markdown-math.ts:559` returns `null` on any `emitted.missing`.
- **`vertical-separator` (`{c|c}` / `{c:c}`)** (`CHANGELOG:29` #697): array column separators write their rule as `style.borderRightWidth`/`borderRightStyle`, not a `Span.width`. Before the fix `svg.ts:617` dropped it entirely; it now emits a stroked line at this pen position with `verticalAlign`/`height` → `(y1,y2)` (`svg.ts:718`).
- **Class-carried padding** (`CHANGELOG:30` #696): `.x-arrow-pad`/`.cancel-pad` etc. exist only in `katex.scss`, so rows measured short by that padding before `CLASS_H_METRICS` (`svg.ts:366`) was folded in at the same point as inline `paddingLeft`. `.cancel-lap`'s `-0.2em` margins were paired in the same table so `\cancel` kept its net advance.
- **Bounded-image and raster caps** (`CHANGELOG:61`, `markdown-math.ts:1938` `destroy` dropping `workerCallbacks`): unrelated to coordinates but load-bearing for a streamed doc — an unbounded `inlineMathRasters` pinned an `HTMLImageElement` per URI past `mathCache` eviction.

## Vendor invariant guards

The stylesheet and kernel conspire to hide information from the tree. Every value below exists in `katex.scss` or a kernel file **but not in `DomSpan`**, so the emitter transcribes it as a constant — and the transcription is verified on every vendor run (`scripts/vendor-katex.ts --check`):

| transcribed constant                                                  | source of truth                                                     | guarded shape                                                                      |
| --------------------------------------------------------------------- | ------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `MU = 1/18` (`svg.ts:60`)                                             | `katex.scss:$mu = 1em/18`                                           | drift guard re-derives `MU` from checked-out `katex.scss`                          |
| `NULL_DELIMITER_SPACE = 0.12` (`svg.ts:69`)                           | `$nulldelimiterspace = 1.2em/10`                                    | same                                                                               |
| `SIZE_MULTIPLIERS[11]` (`fonts.ts:263`)                               | `katex.scss $sizes` + `kernel/Options.ts sizeMultipliers`           | scss flattener re-derives both                                                     |
| `KATEX_FONT_SCALE = 1.21` (`svg.ts:77`)                               | `.katex {font-size:1.21em}` (`katex.scss:24`)                       | same, also asserted `markdown-math.ts:514 ≈ markdown/test/mathBoxGeometry.test.ts` |
| `ROW_ALIGN_CLASSES` (`svg.ts:266`)                                    | `katex.scss` section 405/442/563 + documented `sqrt:left` deviation | same flattener                                                                     |
| `CLASS_TO_FACE`/`DELIM_SIZE_FONTS`/`AVAILABLE` (`fonts.ts:57/98/135`) | `katex.scss` `font-family` rules                                    | same                                                                               |
| `CONTAINER_BORDER_CLASSES` (`svg.ts:308`, `.angl 0.049em`)            | `katex.scss:601` `.angl` top/right rules                            | same                                                                               |
| `OVERLAY_PIECES` windows (`svg.ts:328`)                               | `katex.scss:519` `.brace-*/halfarrow-*` absolute windows            | same                                                                               |
| `CLASS_H_METRICS` paddings (`svg.ts:366`)                             | `katex.scss:555/569/579/583/601` pad/lap/margins                    | same                                                                               |

`defineEnvironment`'s optional props (`argTypes`, `allowedInText`, `numOptionalArgs`) are passed **through with upstream defaults** (`registry/defineEnvironment.ts`), not pinned or dropped, so a future KaTeX bump that starts declaring them surfaces them rather than dropping them silently (`forge/findings/text-richtext-and-markdown.md:2075`).

## How layout interaction actually works

Inline math is **not** `fillText`. `markdown-inline.ts:287` `inlineMath` produces an `InlineObject` (object-replacement character + `InlineObjectBox`) whose `width/height/depth` in px is `exToPx(converted.{widthEx,heightEx,depthEx}, runSize)` — `runSize` is the **enclosing run's** `fontSize` at that point in the span tree, so an `$x$` inside a heading scales with the heading (`markdown-inline.ts:292`). The `LayoutEngine` at `packages/layout/src/LayoutEngine.ts:808` treats it as a fixed box like an inline image. The box's `depth` (distance below the baseline) is `emitted.depth + padEm` in the same `KATEX_FONT_SCALE/EX_PER_EM` scale that the width/height share — seating depth and width are derived together, so a change to `KATEX_FONT_SCALE` mis-sizes every formula while a change to the now-cancelled `EX_PER_EM` moves nothing (`markdown-math.ts:111` cancelled-in-pair note).

Display math bypasses the line breaker entirely: `MathBlock` is a `MarkdownContainer` whose child is the `SVGEntity` of the data URI, at the container width minus `MATH_PAD_EM` padding — margins and overflows are `ScrollView` concerns, not `LayoutEngine` ones.

### How `LayoutEngine` treats an inline formula

`LayoutEngine` (`packages/layout/src/LayoutEngine.ts:808` `LayoutEngine`, `README.md:24` decoupled engine) never shapes TeX. Inline math arrives as one `StyledSpan{ text: OBJECT_REPLACEMENT, object: InlineObject }` (`markdown-inline.ts:301`), whose `InlineObjectBox{width,height,depth}` was fixed at span-collection time from the enclosing run's `fontSize` via `exToPx` — so layout sees the box already in px. The hot `LayoutEngine.layout` path wraps it like any other inline image (`packages/layout/src/LayoutEngine.ts:2321` `layoutPreparedIntoBuffer` preserve-leading note in `forge/findings/text-richtext-and-markdown.md:1762`; `core/src/text/measureContext.ts:12` calibration and `core/src/text/Typography.ts:111` `ctx.measureText('Mg')` fallback are boss 02's text-metric guard the same box depends on): `width` participates in line breaking, `depth` drops the line's baseline by that distance, and `height+depth` grows the line's box so a formula with a large depth (fraction, radical tail, `\left(` tall paren) expands clearance without a second measurement. Selection over the formula is Dual-world parity, not layout — `ContentGridProjector`/`ContentProjectionManager` (boss 01/03) copy the `InlineObject.alt = t.text` (`markdown-inline.ts:310`) so a reader can find/select/copy the TeX source, while the canvas hit remains the `InlineObjectBox` rectangle. Anything that changed `InlineObjectBox` after `LayoutEngine` cached it must dirty the text path — the same `measure-once, layout-many` invariant boss 02 guards.

### Box geometry — why `KATEX_FONT_SCALE` survives and `EX_PER_EM` cancels

`EmitResult` reports em in **KaTeX's** em (1.21× the consumer's font size, `svg.ts:77` `KATEX_FONT_SCALE`, `katex.scss:24`). `markdown-math.ts:514` composes `EX_PER_KATEX_EM = KATEX_FONT_SCALE / EX_PER_EM (0.4421)` so `widthEx = (emitted.width + 2*pad)*EX_PER_KATEX_EM` and `depthEx = (emitted.depth + pad)*EX_PER_KATEX_EM` (`markdown-math.ts:566`). Then `markdown-inline.ts:305` resolves px as `exToPx(ex, runSize) = ex * runSize * EX_PER_EM` — the `EX_PER_EM` cancels, leaving `px = (em+pad)*1.21*runSize`. Verified by mutating `EX_PER_EM` to `0.31` with zero test movement and `KATEX_FONT_SCALE` to `1.0` with 3 failures (`markdown-math.ts:111` note, `test/mathBoxGeometry.test.ts:39` 0.5% tolerance absorbs 2-decimal rounding). The `padEm` is not decorative: the SVG `width/height` attributes include it on all sides while `EmitResult.{width,height,depth}` do not, and `drawImage(bitmap, x,y, box.width, box.height)` at `markdown-math.ts:338` stretches the whole SVG to the box — report the ink box alone and every formula squashes by `padEm`, report depth without it and every formula sits `padEm` high.

## Glyph subset and codec — where the bytes live

The shipped `glyphs.subset.ts` (`src/glyphs/glyphs.subset.ts`) is not SVG path text but the binary decoded by `src/emit/glyphCodec.ts:277` `GlyphTable`. The extraction at `scripts/generate-glyphs.ts` reads TTF `glyf` quadratic contours (on-curve flag + implied mids) and `scripts/encode-glyphs.ts` reverses that expansion: 5 256 of 18 306 `Q` endpoints are exactly implied mids and are dropped, every remaining coordinate is integer (0 of 72 616 off-grid once mids are gone), and zigzag varint deltas pack 60 637 of 72 616 into one byte (`math-engine-2026-08.md:333`). The corpus (`scripts/subset-glyphs.ts`) is what caps display failures — 666 glyphs pinned by `test/glyphCodec.test.ts`'s count guard. A glyph that **exists in `fontMetricsData.js` but not in the subset** renders as a correct-width blank gap (advance from metrics, no outline; `CHANGELOG:62`); a glyph whose **face is entirely absent** (e.g. a display-only whale like `\digamma`) degrades through `markdown-math.ts:559` `emitted.missing.length>0 → null → CodeBlock` — the two failure modes are distinct and have different owners.

### `packages/core/src/text/*` — where TeX meets the text stack

TeX **does not** call `packages/core/src/text` shaping (BiDi, Arabic, OpenType features) — the glyphs are already shaped by KaTeX's metrics, and the emitter writes outlines directly. What TeX **does** share is the bottom half of the text stack: `core/src/text/measureContext.ts:12` measure-context calibration and `core/src/text/Typography.ts:111` `ctx.measureText('Mg')` fallback are boss 02's guards for web-font advances, while TeX's `hmtx`-derived advances at `svg.ts:499` are the KaTeX analogue. Both must satisfy the same text-metric invariant (boss 02 → deep prereq): measure with the real font, on the right context, at the right DPR, or the `InlineObjectBox` drifts from the canvas hit rect and from the a11y projection. `packages/text/src/fontMetrics.ts:82` `registerFontMetrics` is never called for TeX faces — the vendored `fontMetricsData.js` is the TeX metric source, and the two tables have different owners.

### Reading a formula's emitted SVG — placements as ground truth

`EmitResult.placements` (`svg.ts:104` `GlyphPlacement[]` in em) is the debug surface (`markdown-math.ts:517` notes it exists to cross-validate against a real browser layout of the same span tree). When a formula looks wrong, diff placements rather than reading the SVG path soup:

```ts
import { layout, emitSVG } from "@vectojs/tex";
const { svg, width, placements, missing } = emitSVG(
  layout("\\sqrt{b^2-4ac}", { displayMode: true }),
);
// width is advance in em; placements[].{x,y,scale,font,code} in em; missing lists absent U+XXXX
```text

`width` is the only number that gates layout — under-reporting it truncates the `InlineObjectBox`, over-reporting it inserts a visible gap — while `placements[].y` positive-down from the baseline is what must match a KaTeX-in-Chromium DOM probe to 0.0000 em (`math-engine-2026-08.md:423`). A failed clip or overlay shows up as a `PlacedPath.w/clip.w` mismatch to `placements` extents, not as a path-string difference.

## Verification harness — what keeps each invariant green

- `test/emit.test.ts:37` — self-contained SVG contract (`<text>`/`font-family`/`url`/`xlink:href` absent; data-URI fragment resolves); stretchy overlay zero-advance and slice windowing (`emit.test.ts:380` `treats multi-piece stretchy overlays as zero-advance`).
- `test/svgClipWindows.test.ts:6` — renderer-geometry regressions for #787/#788: clipPath rect emitted in path-local frame, and aligned-vlist replay coincident window under non-1 `sy` (`svgClipWindows.test.ts:83` overbrace tiling).
- `test/vendorCheck.test.ts:252` — drift guard re-deriving every `katex.scss`-transcribed constant from the upstream checkout (the comment-brace trap is a MathJax import, not this package).
- `packages/markdown/test/mathBoxGeometry.test.ts:39` — KaTeX font-scale bridge (`KATEX_FONT_SCALE` equality across packages) and box geometry against real KaTeX in Chromium (19.3559 px/em at 16px, 0.02% spread).

## How to add a new TeX construct safely

A TeX construct is defined by a **kernel builder** (AST → spans + styles/classes) and consumed by **one emit branch** that translates those spans/styles into placed ink against the right extent. A construct is considered shipped only when **seven** sites agree — missing any one was the historical failure mode.

### 1. Add and verify the kernel builder

Extend `src/kernel/functions/*.ts` or `src/kernel/environments/*.ts` via `src/registry/defineFunction.ts` / `defineEnvironment.ts` (not by editing the kernel). Verify the builder's **output contract**: what classes it sets (e.g. `.mover`, `.angl`, `.cancel-pad`), what inline styles it writes (`borderBottomWidth`, `paddingLeft`+`padLeftEm`, `minWidth` on hide-tail wrappers), whether the wrapper is a `Span`, an `SvgNode`, or a `LineNode`-bearing `SvgNode` (`kernel/stretchy.ts:69`, `svgGeometry.ts` for the path catalog), and whether `style.top`/`style.left`/`style.color`/`transparent` is involved. The kernel's `fontMetricsData.js` measurements already flow into the tree's `height/depth` — do not reintroduce them as a second source.

### 2. Teach the emitter exactly one new branch

Dispatch lives at `svg.ts:427` `walk` → `emitSymbol`/`emitSvgNode`/`emitContainer`/`emitVList`. If the new spans carry **new CSS classes that affect geometry**, register them in the right table rather than hard-coding:

- `CLASS_H_METRICS` for inline pad/margin (e.g. `.x-arrow-pad`, #696) — otherwise rows measure short.
- `CONTAINER_BORDER_CLASSES` for a border edge whose thickness lives only in `katex.scss` (e.g. `.angl`, `svg.ts:308`).
- `ROW_ALIGN_CLASSES` if a vlist rows' `text-align` matters (`.op-limits` etc., `svg.ts:266`).
- `OVERLAY_PIECES` if the new spans are `position:absolute` percentage windows (`svg.ts:328`).

If the construct's SVG declares a fixed width (400em) but its **visible** width is the enclosing row's extent, treat its SvgNode as a **zero-advance pending overlay** rather than literal advance (the `\phase`/`\overbrace` pattern at `svg.ts:859` `#665` / `svg.ts:966` `#667`).

### 3. Place it in the correct coordinate space

- A **rule or border** that spans its container is `PlacedRect{fullWidth:true, edge?}` at `svg.ts:147`, resolved by `placeRect(startX,width)` against **its own enclosing `vlist` row** (`svg.ts:1230` `rectStart` range), not the formula's `state.x`.
- A **stretchy single path** whose visible width is not its declared `width` is `PlacedPath{clip?}` at `svg.ts:193`, with `sliced` handling at `svg.ts:596` (scale by `rawWidth`, not `widthEm`) and — if `hide-tail` without `minWidth` — pending as `FULL_WINDOW` (`svg.ts:966`).
- A **multi-piece overlay** is `PlacedPath{overlay}` at `svg.ts:193` with `placeOverlay` cover scale + `preserveAspectRatio` alignment (`svg.ts:1275`) and clipping to the window (so each piece draws its fraction of the container).
- A **vertical separator** (`vertical-separator`, #697) is a stroked `PlacedLine` (`svg.ts:173`) whose `(x1,y1)→(x2,y2)` recovers `aboveEm = height + verticalAlign` — the same derivation `svg.ts:718` already does.

### 4. Preserve colour, phantom, and escaping

Inherit the effective `style.color` through `walk` (`svg.ts:132` `ColoredPlacement`, `svg.ts:479` `color=style.color ?? inheritedColor`, `svg.ts:744` phantom test on that value), keep advances while skipping ink when `color==="transparent"` (handles `\phantom`/`\vphantom`/`\hphantom`/`\mathstrut`'s `rlap` — `buildCommon.ts:96`, `svg.ts:479`), group same-colour runs into `<g fill=…>` (`svg.ts:1522`), and escape any interpolated colour via `escapeAttr` (`svg.ts:1542`) — today's callers are theme-derived, but a value from TeX input like `\color{…}` writes the arg verbatim into `style.color` and breaks out of the attribute otherwise.

### 5. Correct sizing — elect the right threshold

`KATEX_FONT_SCALE` and `sizingRatio` compose multiplicatively in two places: the pen advance (`UPEM * scale` at every `parseEm` ×) and the `PlacedGlyph.scale` (`fonts.ts:265`). A wrong entry in `SIZE_MULTIPLIERS` misplaces script-size glyphs by ~50%, which no viewBox repair catches.

### 6. Update the measurement contract

If the construct's geometry includes the container extent (vlist `width`, radicand width, brace window), it must be **resolved after the width is known** (`emitVList` `maxX-startX` at `svg.ts:1227`; fallback to formula `state.x` at `svg.ts:1588` in `emitSVG`). The previous unbounded viewBox at `svg.ts:1630` (union of placed ink, not just the layout box) is load-bearing — expanding that box was #521's fix for `\smash`/`\hphantom` where `height/depth` are zero but children keep size.

### 7. Keep the two guardrails green

- `scripts/subset-glyphs.ts` — if the construct exercised new code points, add them to the subset corpus (`src/glyphs/glyphs.subset.json`) and re-run the codec guard (`test/glyphCodec.test.ts` pins `package.json` non-`sideEffects:false` and the 666-glyph count) so the corpus cannot silently drop the new range. Missing but metric-present code points render as **blank correct-width gaps** (`CHANGELOG:62` #665); display-only code points render as **raw LaTeX source** (`CHANGELOG:9`).
- `scripts/vendor-katex.ts --check` — add any **new** CSS-transcribed constant (`ROW_ALIGN_CLASSES`, `CLASS_H_METRICS`, `OVERLAY_PIECES` etc.) to the drift guard that re-derives each value from the upstream checkout (`test/vendorCheck.test.ts` SCSS flattener), so a stylesheet change at the next KaTeX bump fails loudly rather than silently shifting every construct that relied on it (`CHANGELOG:62` drift-guard addition).

## Debugging checklist

| symptom                                                                           | check first                                                                          | file:line                                                                   |
| --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ | --------------------------------------------------------------------------- |
| All stretchies off-canvas / `p.x+sx·clip.x` doubled                               | Clip path emitted in root space instead of path-local                                | `emit/svg.ts:1555` `invSx/invSy`                                            |
| `\overbrace`/`\xleftrightarrow` measures 400×N em; viewBox 400× too wide          | Multi-piece SVG taken as literal advance rather than zero-advance pending overlay    | `emit/svg.ts:859` `OVERLAY_PIECES` + `emitOverlayPiece`                     |
| `\phase` measures 400em while `\sqrt{x}` is correct                               | `hide-tail` with no inline `minWidth` still advances 400em                           | `emit/svg.ts:966` `unclippedHideTail`                                       |
| `\sqrt{b^2-4ac}` vinculum truncated to `0.853em`, radicand partly outside radical | Clip sized to `minWidth` not `max(minWidth, radicandWidth)`, or `sqrt: center`       | `emit/svg.ts:1186` `clip.w < width` + `svg.ts:266` `sqrt:left`              |
| `\sum_{i}` limits flush left; `\xrightarrow{label}` label at arrow left edge      | Row alignment class missing                                                          | `emit/svg.ts:266` `ROW_ALIGN_CLASSES`                                       |
| `\underline`/`\overline`/`\hline`/`\sout` missing                                 | Border span without width — dropped because only `frac-line` considered              | `emit/svg.ts:800` `borderBottomWidth/katex-sout`                            |
| `\boxed`/`\angl` box edge invisible                                               | Border thickness only in `katex.scss` (`.angl`) or `borderStyle` shorthand not read  | `emit/svg.ts:834` `CONTAINER_BORDER_CLASSES` + shorthand                    |
| `{c                                                                               | c}`rules invisible;`:` solid instead of dashed                                       | `vertical-separator` span dropped; `borderRightStyle===dashed` not applied  | `emit/svg.ts:718` `dashed` + `svg.ts:1597` `stroke-dasharray` |
| `\llap`/`\clap` ink to the right of the anchor                                    | All three laps using `rlap` (`left:0`) semantics                                     | `emit/svg.ts:982` `llap/clap` width probe + shift                           |
| `\smash`/`\hphantom` content clipped by viewBox                                   | ViewBox derived from zeroed `height/depth` not the union of placed ink               | `emit/svg.ts:1630` `minY/maxY` ink union                                    |
| Colours dropped; `\color{red}x` black or unknowns look valid                      | `style.color` not inherited; or known missing glyphs not gated via `emitted.missing` | `emit/svg.ts:479` + `markdown-math.ts:559` `missing.length>0` degrade path  |
| Narrow gap/overmeasure on `\xrightarrow{\text{…}}` / `\boxed` / `\cancel`         | Class-carried `padLeft/padRight/marginLeft` not folded into advance                  | `emit/svg.ts:366` `CLASS_H_METRICS`                                         |
| Tall delimiter a short paren / wrong italic (`\mathit{123}` normal)               | Font resolved without ancestor `classChain`                                          | `emit/svg.ts:427` + `fonts.ts:194` `resolveFont(chain)`                     |
| `Got group of unknown type` at `layout('x')` after `bun build`                    | `packages/tex/package.json` set to `sideEffects:false` — registries tree-shaken      | `packages/tex/package.json` + `test/glyphCodec.test.ts` guard on that field |

## Streaming and why `layout → emit` is not re-entrant mid-line

Inline math's `InlineObjectBox` is fixed **before** `LayoutEngine` sees it, so the TeX pipeline is never called inside the layout hot path. `markdown-math.ts:85`'s lazy `import('@vectojs/tex')` means the first formula on a page renders as styled source (the `else` at `markdown-inline.ts:316` `theme.mathFallbackColor`) until `preloadMathJax()` resolves — `ensureMathJax`/`retypesetFromTokens` (`markdown/src/Markdown.ts:3518`) coalesce concurrent loads onto one promise and rebuild from already-lexed tokens, keeping `tokenChildPrefix` trivially correct. `inlineMathRasters`'s LRU at `markdown-math.ts:238` re-inserts on every paint so a still-visible bitmap is not evicted, and `mathCache` (256) plus raster cap at the same bound is the streaming guard against a long-lived document that decodes thousands of distinct formulas (`forge 2026-08-13` bounded-raster finding). A second caller that `await preloadMathJax()` before constructing gets synchronous first-formula typesetting — the same contract boss 04's `onStable` depends on when it snapshots `Array.from(content.children)` after `waitForAppendSettled`.

That `degrade-to-source` contract is also the glyph-miss contract: `convertMathToSVGDataURI`'s `emitted.missing.length>0 → null` (`markdown-math.ts:559`) renders a partially-missing formula as **copied TeX source** rather than a silently gapped equation, so a corpus addition that forgot a glyph is visible as a blue `CodeBlock` rather than as a wrong equation. Display math's fallback (`markdown/src/Markdown.ts:3520` `retypesetFromTokens` wholesale) respects the same contract — a block `\digamma` that lacks an outline never produces a gapped display block, it stays source.

### `packages/core/src/text/*` and the deeper text invariant

`core/src/text` (`core/src/text/Typography.ts:111`, `measureContext.ts:12`) shapes **web** text — BiDi, Arabic joins, variable-font advances — not TeX. The two stacks meet only at `InlineObjectBox`: both are `width/height/depth` boxes that `LayoutEngine` (`packages/layout/src/LayoutEngine.ts:808`) wraps identically. Boss 02's `measure-once, layout-many` invariant therefore governs both: a stale `InlineObjectBox` after a font, DPR, or width change is a parity bug whether the box holds TeX or `fillText`. TeX never calls `registerFontMetrics` (`packages/text/src/fontMetrics.ts:82`) — its metrics are the vendored `fontMetricsData.js`; the two tables have different owners but one layout truth.

## Invariants — copy-paste checklist before PR

1. **Depth-stable class chain.** `resolveFont(classChain)` and `sizingRatio(classChain)` threaded from the real accumulation (`walk` `chain=[…classChain,…classes]`), not a leaf slice.
2. **Every inline length is `parseEm * UPEM * localScale`.** No second scaling on replay — the scale is baked in.
3. **Any shape whose extent is the container extent is pending until `place*(startX,width)`.** A second consumer reading the same range in a different vlist would otherwise stretch a radical to a fraction's width.
4. **No `parseFloat("100%")` as `100em`.** `parseLength`/`parseEm` split `pct` vs `em`; percent x in `\cancel` overlays defers to the vlist width like a full-width rule.
5. **Glyph ⇔ font invariant.** Two glyphs of the same face that repeat share one `<defs><path>` and `href="#gN"` reuse (`svg.ts:1639` `defId` map); the miss set is computed from the same font resolution that fed `getGlyph`, so `convertMathToSVGDataURI` at `markdown-math.ts:559` drops exactly the formulas whose ink would have a gap.
6. **Padding belongs to the SVG and to the box together.** `EmitResult.{width,height,depth}` are **ink**; `Emitted.svg` `width/height` include `+padEm` on all sides. `convertMathToSVGDataURI`'s `+pad2`/`+MATH_PAD_EM` arithmetic depends on the named pad constant — decouple and every markdown formula mis-seats.
7. **Ellipsis/dashes in prose are not inside TeX or code.** `decodeProse`/`applyTypography` (`markdown-inline.ts:58`) route only through `emitProse` — code spans and the math-failure fallback (`markdown-inline.ts:321`) bypass them, so `--` inside `code` or a degraded `$$` never becomes an en dash.

---

## References

- `vectojs-docs/content/learn/text-typography.md` — what `TextStyle.baselineShift`/`fontSize` buy for sub/sup (the other inline-math-like raised run).
- `vectojs-docs/content/learn/streaming.md` + boss 04 — why `marked` extensions affect `findStableCut`, and why inline math's `InlineObjectBox` differs from `RichText` spans.
- `vectojs-docs/forge/decisions/math-engine-2026-08.md` — the measured decision, vendor scope, glyph encoding choice, correction 5 (`sideEffects:false`), and the four-part TeX difficulty ranking.
- `vectojs-docs/forge/findings/text-richtext-and-markdown.md:1789-1924` — all nine 2026-08-13 P2/P3 tex findings + the bounded-raster finding in one place.
- `vectojs-docs/forge/baselines/*.json` + `run-browsers.sh` — the only quotable numbers; headless paths are a regression tripwire.
- `packages/tex/test/emit.test.ts` + `svgClipWindows.test.ts` + `vendorCheck.test.ts` — the contracts a new construct must keep green (clip-window coincidence, multi-piece windowing, drift guard).

---

_Next: 06 VMT Runtime — the lifecycle, dirty propagation, and event dispatch that every emitter-built `SVGEntity` and `MathBlock` mount onto._
