---
title: "02 — Text & Layout: Unicode to Pixels"
description: "The full text pipeline — segmentation, BiDi, Arabic shaping, font fallback, Typography, line breaking, the LayoutEngine cold/hot split, worker threading, and the invariants that keep paint and measure in parity."
order: 22
---

# 02 — Text & Layout: Unicode to Pixels

> VectoJS re-implements what the browser's text stack gives you for free: bidi, shaping, segmentation, font fallback, line breaking, and baseline placement. This dossier traces every stage from a Unicode `string` to positioned glyphs and explains the contracts that keep `measure` and `paint` agreeing by construction.

## 1. Pipeline at a glance

```text
Unicode string
  │  Intl.Segmenter (word + grapheme)          packages/layout/src/LayoutEngine.ts:916
  ▼
 Grapheme segmentation ─┬─ ArabicShaper.shapeArabic  packages/text/src/ArabicShaper.ts:89
                        │  indexMap: shaped → source       :91
                        ▼
 BiDi resolution (bidi-js, UAX #9)            packages/text/src/BidiResolver.ts:27
  getBaseLevel / resolveLevels / reorderSegments
                        │
                        ▼
 Font fallback (atlas → measurer → 0.5em)     packages/layout/src/measure.ts:39
  createCanvasMeasurer / createMetricsMeasurer / resolveGlyphMeasurer
                        │
                        ▼
 Typography (baseline in line box)            packages/text/src/Typography.ts:93
  cssLineBoxBaseline / registeredBaseline / splitFontShorthand
                        │
                        ▼
 Line breaking + exclusion flow + justify     packages/layout/src/LayoutEngine.ts:1848
  computeLineSegments / suppressLineBreaks / LayoutEngine.layoutPrepared
                        │
                        ▼
 Paint / measure parity ─┬─ @vectojs/layout  (canvas Text/RichText)
                         └─ @vectojs/text    (MSDF: MSDFFont.layout)  packages/text/src/MSDFFont.ts:201
                         └─ @vectojs/core    (MSDFTextEntity → worker) packages/core/src/text/MSDFTextEntity.ts:25
```text

Two parallel consumers share the same measurement contract: the **canvas path** (`@vectojs/layout` + `measureContext`) and the **GPU/MSDF path** (`MSDFFont.layout` + `LayoutWorker`). Results diverge only in how quads become pixels, never in where line breaks fall per family.

For grid consumers (terminals, editors, `CodeBlock`) the pipeline forks earlier into the retained grid path `prepareContentGrid` (`packages/text/src/PreparedContentGrid.ts:243`) — one compilation, two consumers (paint + projection). See `tmp/boss-research/01-selection.md` §3.3 for the content-grid side.

### Cold / hot separation (the 2.68× that makes resize cheap)

```text
prepare(text) / prepareRich(spans)          ← cold:  Intl.Segmenter + Arabic shape + BiDi + glyphWidth
  └─→ PreparedText { paragraphs, fontSize }      memo'd by text+fontSize+styleSig (LayoutEngine.ts:829/833)
       │  independent of maxWidth / maxHeight / exclusions
       ▼
layoutPrepared(prepared, mask, exclusions)  ← hot:   computeLineSegments + suppressLineBreaks + shiftedExtent
measurePrepared(prepared)                   ← hot (no alloc): lineCount+height only
layoutPreparedIntoBuffer(prepared, buffer)  ← hot, zero-GC: typed arrays + reorderSegments
```text

`benchmarks/text-layout-pretext` / `comparisons/text-layout-pretext` / `scripts/compare-pretext.ts:1` established the apples-to-apples split (`measurePrepared` vs `pretext.layout`). Before the split, `layoutText` (cold+hot) was timed against pretext's hot-only `layout` — the gap was reported as engine cost when it was really segmentation cost.

### Segmenters and their caches

`LayoutEngine` (`:916`) holds `wordSegmenter` + `charSegmenter` (`Intl.Segmenter`, locale `navigator.language ?? 'en-US'`) — auto-detecting CJK vs Western word boundaries — plus `wordCache: Map<string, …>` (`:821`, cap 500) and `graphemeCache: Map<string,string[]>` (`:822`, cap 2000). Both are wholesale-flushed at cap (`:921`/`950`) and observed through `cacheStats()` (`:1004`). `PreparedContentGrid` prefers the same `Intl.Segmenter` for graphemes (`:76`) but carries `fallbackGraphemes` (`:107`) for environments without it: combining marks, VS16/VS15, skin-tone modifiers `U+1F3FB–1F3FF`, regional indicators, ZWJ — enough to keep tab stops and wide columns correct. `LayoutEngine.getGraphemes` (`:943`) and `getWordSegments` (`:881`) are the only call sites; `shapeSimpleRun` (`:1644`) bypasses `ArabicShaper` only after `isComplexScript` (`:584`) proves it safe.

## 2. Per-module deep dive

### 2.1 `packages/text/src/BidiResolver.ts:27` — UAX #9 via `bidi-js`

Static-only class (intentionally — `BidiResolver.getBaseLevel(...)` is public API). Thin wrapper over `bidi-js`'s `getEmbeddingLevels` / `getReorderedIndices` / `getReorderSegments`; the previous hand-rolled L2 reversal was replaced because its L1 reset handled only a single trailing-whitespace run.

| Method                                    | Line   | What it does                                                                                                                                                                                                                                                                                                                              |
| ----------------------------------------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `getBaseLevel(text)`                      | `:29`  | Paragraph embedding level P2/P3 (0 LTR, 1 RTL).                                                                                                                                                                                                                                                                                           |
| `resolveLevels(text)`                     | `:34`  | Per-character resolved levels X1–I2 (`Uint8Array`).                                                                                                                                                                                                                                                                                       |
| `reorderIndices(text)`                    | `:50`  | Visual→logical permutation L1+L2 (`indices[v] = logical index at visual column v`). Authoritative — selection maps logical ranges to visual runs through this.                                                                                                                                                                            |
| `logicalToVisualRuns(text, start, end)`   | `:62`  | One logical `[start,end)` → N visual `[visualStart,visualEnd)` runs, sorted left-to-right. A single selection rect becomes several when it straddles a direction boundary.                                                                                                                                                                |
| `reorderVisual<T>(nodes, baseLevel)`      | `:89`  | In-place L1+L2 reversal of one line's nodes. Reconstructs `str` + `levels` and iterates `reorderSegments`. Hot in every wrapped line.                                                                                                                                                                                                     |
| `reorderSegments(str, levels, baseLevel)` | `:121` | Same permutation as typed-array `[start,end]` pairs (`packages/layout/src/LayoutEngine.ts:2466` comment) — lets the zero-GC buffer path (`layoutPreparedIntoBuffer`) apply it without allocating `BidiNode` objects per glyph. Synthesizes `embed = { levels, paragraphs:[{level: baseLevel}] }` so L1 resets to the paragraph direction. |

Cost: one `bidi-js` pass per paragraph. No per-glyph work beyond the array build in `reorderVisual`.

### 2.2 `packages/text/src/ArabicShaper.ts:18` — contextual shaping

Presentation-form substitution for the Arabic block plus Persian/Urdu extensions. `MAPPINGS: { [code]: GlyphForms }` (`:18`) records `isolated/initial/medial/final` code points and `joining: 'D'|'R'|'U'` per code point. Tatweel `U+0640` is `'D'` but emits the same code point in every form (`:052`) so joining passes through.

- `isHarakat(code)` (`:70`) — `U+064B–065F`, `U+0670`, `U+0610–061A` (honorific signs), `U+06D6–06ED` (Quranic annotations) plus the three harakat-adjacent mark ranges. All have joining type TRANSPARENT — shaping must skip across them or honorific text disconnects. Mirrors `MSDFFont.ts:isNonspacingMark` (`:132`).
- `getJoiningType(code)` (`:84`) — table lookup, `'U'` when absent.
- `shapeArabic(text)` (`:89`) — single left-to-right walk: ligature lookahead (`lam+alef` `U+0644` + `U+0627/0622/0623/0625` → presentation ligature, `k` pointer `:105`), `connectPrev`/`connectNext` (`:182`/`:187`) computed by scanning backward/forward over transparent marks, `glyph = forms.isolated/initial/medial/final`. Returns `{ shapedText, indexMap: Int32Array }` (`:1`) — `indexMap[visualIndex] = sourceOffset` so `LayoutEngine` can recover `sourceIndex/sourceLength` after shaping.

Selection contract: visual positions reorder, but `sourceIndex` always indexes the original logical string.

### 2.3 `packages/text/src/measureContext.ts:41` — measure where you paint

The module that exists to enforce one invariant. A detached `HTMLCanvasElement` resolves generic families (`monospace`, `serif`) to a **different font** than the document's attached canvas on Gecko, because the generic→real mapping lives in a per-language font preference reachable only from a live style context.

Header table (`:1`): Firefox 153, `<html lang="zh">`, DPR 1.5789, `measureText('MMMMMMMMMM')` — detached `22px monospace` 109.7, attached 131.6, layout 132.0; detached `serif` 109.7/205.5 — both collapsed onto one hardcoded fallback, 20–47% error. Chromium unaffected. `OffscreenCanvas` measures 132.0 (matches layout) but is not used — agreeing with the **painted** canvas matters more.

- `createMeasuringContext()` (`:62`) — 1×1 canvas, `position:absolute;opacity:0;left:-9999px;top:0`, `aria-hidden`, appended to `document.body`. `display:none` would remove it from layout and lose the style context; detached is the failure mode.
- `getSharedMeasuringContext()` (`:87`) — the single shared context (`:41` `sharedCanvas`/`sharedContext`). Memoizes `null` (`undefined` vs `null` distinction, `:98`) so SSR (`typeof document === 'undefined'`) does not retry creation per glyph. `ctx.font` is set before every read; nothing width-cached travels with the context.
- `isSharedMeasuringContextAttached()` (`:118`) / `resetSharedMeasuringContext()` (`:130`) — diagnostic + recovery for contexts created before `document.body` existed. Today no in-repo caller auto-recreates; call site pattern documented at `:111`.

Every measurer must call this. `packages/layout/src/measure.ts:42` does. Grepping detached `document.createElement('canvas')` in `packages/` is the audit.

### 2.4 `packages/text/src/fontMetrics.ts:14` — DOM-free metrics registry

For environments with no canvas at all (SSR, worker without `OffscreenCanvas`, tests). Values in **em units** so one registration serves every size.

- `FontMetricsSource` (`:14`) — `advanceEm(char)`, optional `measureEm(text)` (kerning-aware), `ascenderEm`/`descenderEm`. The fallback for `measureEm` is summing `advanceEm`, correct but drops kerning.
- `normalizeFamily` (`:45`) — first family only, quotes stripped, lower-cased. A fallback chain is a renderer concern, not a registry concern.
- `registerFontMetrics(family, source)` (`:82`), `registerMSDFFontMetrics(family, font)` (`:97`), `createMSDFMetricsSource(font)` (`:114`) — `advanceEm` from `font.getGlyph(code)?.advance`, `measureEm` from `font.layout(text, 1).width` (the only path that can kern — per-glyph `GlyphMeasurer` has no neighbour). `ascenderEm`/`descenderEm` from `font.data.metrics`. `hasFontMetrics` (`:154`) is the cheap probe to short-circuit when nothing is registered.
- `fontMetricsVersion()` (`:64`), `getFontMetrics` (`:141`), `clearFontMetrics` (`:163`). Version counter lets callers cache a resolved source and re-resolve only when it bumps — capturing a source without checking pins whatever was registered at the time (`:107` in `measure.ts`). `createMetricsMeasurer` (`measure.ts:96`) therefore holds `baseVersion/runVersion` lazily and compares once per glyph instead of calling `normalizeFamily` per glyph (`+13%` overhead avoided on the measurer hot path).

### 2.4b `packages/text/src/index.ts:1` — the barrel

Re-exports `ArabicShaper`, `BidiResolver`, `measureContext`, `PreparedContentGrid`, `MSDFFont`, `fontMetrics`, `Typography` (`:1`). `@vectojs/layout` imports from `@vectojs/text` (not relatively) — `LayoutEngine.ts:1` `import { ArabicShaper } from '@vectojs/text'` — so the package boundary is observable. The `LayoutWorkerManager` singleton also caches `MSDFFontData` (`LayoutWorkerManager.ts:043`) across worker death for exactly this reason: metric data crosses the thread boundary once and must remain available for the fallback path.

### 2.5 `packages/text/src/Typography.ts:4` — baseline in the CSS line box

CSS centers font ascent+descent in the line box; canvas draws at an explicit y. They must agree or a `fillText` and its native mirror sit at different baselines.

- `BASELINE_CACHE_MAX = 512` (`:12`), `baselineCache: Map<string,number>` (`:4`), `rememberBaseline` (`:14`) — insertion-order LRU (delete+re-set on hit, `:98`). 512 covers every font in a realistic document; a miss re-measures one `'Mg'`.
- `splitFontShorthand(font)` (`:33`) — anchored on `indexOf('px')` and walking back over digits, not `/(\d+)px/` (polynomial ReDoS, `js/polynomial-redos`, high). Mirrors parsers in `@vectojs/ui`/`@vectojs/markdown` with intentionally different failure values.
- `registeredBaseline(font, lineHeight)` (`:67`) — DOM-free path from `getFontMetrics`. `(lineHeight - ascent - descent)/2 + ascent` with `descent = -descenderEm * size`; fallback `lineHeight * 0.8`.
- `cssLineBoxBaseline(font, lineHeight)` (`:93`) — ordered choice: SSR→`registeredBaseline`; cache hit→return; `getSharedMeasuringContext` (attached, `:107`) → `ctx.measureText('Mg')` → `fontBoundingBoxAscent/Descent || actualBoundingBoxAscent/Descent` (`:112`) → same centering formula; degenerate metrics→`0.8` fallback. The same `0.8` constant anchors `LayoutEngine.ts:shiftedExtent` (`:668`) and the line-box `1.5 * pMax`/`0.8 * pMax` geometry.
- `clearCssLineBoxMetrics()` (`:122`) — call after a webfont finishes loading.

### 2.6 `packages/text/src/MSDFFont.ts:151` — GPU text

Parses `msdf-atlas-gen` JSON (type `msdf`/`mtsdf`/`sdf`), lays out quads in CSS pixels with atlas UVs. Renderer conventions: local space y-down, top-left origin; UVs `v=0` at atlas top (no Y-flip on upload).

- Interfaces: `MSDFAtlasInfo` (`:16`, `distanceRange/size/width/height/yOrigin`), `MSDFMetrics` (`:32`, `lineHeight/ascender/descender`), `MSDFBounds` (`:45`), `MSDFGlyphDef` (`:53`, `unicode/advance/planeBounds/atlasBounds`), `MSDFKerning` (`:64`), `MSDFFontData` (`:71`), `PositionedGlyph` (`:79`, `x/y/w/h + u0/v0/u1/v1`), `MSDFLayoutResult` (`:96`, `glyphs/width/height`), `MSDFLayoutOptions` (`:105`).
- `kernKey(a,b)` (`:115`) — `a * 0x110000 + b`; `isNonspacingMark(code)` (`:132`) — explicit range list (cheap in per-glyph loop, no `\p{Mn}` regex), mirrors `LayoutEngine.ts:isComplexScript` (`:584`).
- `MSDFFont` (`:151`) — `id` (`font-${idCounter++}` `:164`), `byCode: Map<number,MSDFGlyphDef>`, `kern: Map<number,number>`, `missingAdvance` (`:158`, space→`.notdef`→`0.5`). `parse` (`:173`), `getGlyph` (`:178`), `distanceRange`/`atlasWidth`/`atlasHeight` (`:183`).
- `layout(text, fontSizePx, opts)` (`:201`) — codepoint-aware (`Array.from(text)` `:212`), honors `\r\n`/`\r` as one break (`:214`), missing glyph → `missingAdvance * size` (never 0, or later glyphs shift left) except `isNonspacingMark` which advances 0 (`:233`) and does not replace `prevCode` for kerning (`:252`). Kerning `k * fontSize` (`:242`), `baseline = y + (ascender + line*lineHeight)*size` (`:246`), `planeBounds`→quad (`:246`ff), `yOrigin` flips `v0/v1` (`:250`). Returns `{ glyphs, width: maxAdvance, height: (line+1)*lineHeight*size }`.

### 2.7 `packages/text/src/PreparedContentGrid.ts:38` — the retained grid plan

Immutable, source-aware geometry for grid text. Compile once, share between canvas paint and DOM projection — re-segmenting would place bidi, tabs, and wide glyphs differently.

- `PreparedContentGrid` (`:38`) — `{ kind:'content-grid', revision, source, font, cellWidth, lineHeight, baseline, tabSize, lines }`; `PrepareContentGridOptions` (`:50`); `MutableCell` (`:63`).
- `graphemeSegmenter` (`:76`, `Intl.Segmenter` with `grapheme` granularity) with `fallbackGraphemes` (`:107`) covering combining marks, variation selectors, emoji modifiers, keycaps, regional indicators, ZWJ. `graphemes()` (`:151`) prefers `Intl.Segmenter`.
- `isWideCluster` (`:170`) — `EAST_ASIAN_WIDE` (`:91`, CJK blocks) + `EXTENDED_PICTOGRAPHIC` with `VS16`/`VS15` sensitivity + `EMOJI_PRESENTATION` + `REGIONAL_INDICATOR`/`0x20E3`. Wide → 2 columns.
- `sourceLines` (`:197`) — owns `\r\n`/`\r`/`\n`; `sourceStart/sourceEnd/nextSourceStart` so every later offset is correct.
- `prepareContentGrid(source, opts)` (`:243`) — per line: `rawCaretBoundaries` from `graphemes(rawLine)`, `ArabicShaper.shapeArabic(rawLine)` (`:270`), `graphemes(shaped)`, `BidiResolver.resolveLevels` (`:273`), cell per shaped grapheme with `sourceStart/sourceEnd` via `indexMap` (`:278`), `sourceCaretOffsets` via `lowerBound` (`:159`), `columns = 0/ tabStop / wide?2:1` (`:298`), `BidiResolver.reorderVisual(visualCells, getBaseLevel(shaped))` (`:315`), `x` pass (`:317`). Frozen before return.

### 2.8 `packages/layout/src/LayoutEngine.ts` — the prose layout engine

~3.4k lines, the heaviest single file in the text stack. Architecture is a **cold/hot split** over typed contracts.

**Cold half** (expensive, constraint-free):

- `prepare(text, atlas, size)` (`:1080`) / `prepareRich(spans, atlas, size, baseStyle)` (`:1266`) — run `Intl.Segmenter` (word `:916` + grapheme `:917`), resolve glyph advances via `glyphWidth` (`:929`, atlas→`GlyphMeasurer`→`0.5em`), shape (`ArabicShaper` `:1117`), resolve bidi (`BidiResolver` `:1123`/`:1524`), build `PreparedText` (`:462`). Result is independent of `maxWidth`/`maxHeight`/exclusions. Paragraph memoization: `paragraphCache: Map<string,PreparedParagraph>` (`:829`) keyed by `${fontSize} ${paragraph}`; rich variant `richParagraphCache` (`:833`) keyed by `${fontSize} ${text} ${styleSig}` where `styleSig` is an RLE value-signature over `TextStyle` fields + `InlineObject` identity (bold/italic/color/href/fontFamily/baselineShift/highlightColor/abbrTitle plus object `width/height/depth/alt/key`). Atlas identity change clears both (`:1095`/`:1275`).

**Streaming fast path** inside `prepareRich`: `streamShapeCache` (`:839`, single-slot incremental cache). Conditions at `:1358`: single paragraph, no `\n`/`\r`, `!isComplexScript(fullText)` (`:584` — Arabic/Hebrew/Indic/combining/bidi marks/emoji modifiers fall through to full shaper). When `fullText` strictly extends `cache.text`, styles equal over the prefix (`styleRangeEquals` `:682`, `objectRangeEquals` `:628`), reuse prefix words verbatim and call `shapeSimpleRun(fullText, reshapeFrom, ...)` (`:1644`) only over the suffix. `reshapeFrom` is not `cache.end` but the start of the trailing same-category (whitespace vs non-whitespace) run so `Intl.Segmenter` boundaries that dissolve when the next chunk arrives (e.g. `"3"+"."+"1"` → `"3.1"`) are rebuilt correctly. Status: shipped, measured correctly edge-case win, negligible on realistic docs (memo already caps per-paragraph cost) — held from standalone `@vectojs/core` release per `forge/findings/text-richtext-and-markdown.md:356`.

**Hot half** (cheap, constraint-bound):

- `layoutPrepared(prepared, exclusionMask?, exclusions?)` (`:1848`) / `measurePrepared` (`:1772`) / `layoutPreparedIntoBuffer(prepared, buffer, mask?)` (`:2241`) — walk `PreparedText` words, place glyphs at `currentX/currentY`, honor `maxWidth`/`maxHeight`, `exclusions: ExclusionRect[]`, `computeLineSegments(top,bottom,maxWidth,exclusions)` (`:504`, `O(n log n)` merge of x-intervals, complement within `[0,maxWidth]`), orphan-punctuation suppression (`suppressLineBreaks` `:721`, `'@'` join + closing punct merge), hyphenation (`breakPoints` from `U+00AD` or `this._hyphenate` hook, `hyphenWidth` `:490`), justify (`textAlign:'justify'` only on multi-run lines), `shiftedExtent(gfs, shift, pMax)` (`:668`) applying the shared `0.8/0.2` line-box split so a raised superscript grows the line only when it would leave the box. `layoutPrepared` allocates `LayoutNode[]` + `LayoutResult`; `layoutPreparedIntoBuffer` writes flat typed arrays without allocation and applies the same BiDi `reorderSegments` pass.

Other load-bearing pieces: `EMPTY_GLYPH_ATLAS` (`:83`, frozen constant — `Text`/`RichText` pass it so the paragraph memo is not invalidated per call by a fresh `{}` literal; measured 2.68× on 200×12 paragraph re-layouts `:64`); `unmeasuredGlyphCount()`/`resetUnmeasuredGlyphCount()`/`setUnmeasuredGlyphWarning()` (`:8` — `0.5em` fabrications are counted, not silent; `fallbackToCanvas` (`:380`, tri-state `undefined` vs `true`) only reports missing-atlas, not missing-measurer); `GlyphMeasurer` (`:92`, `measure(char,size,family,bold,italic)` — per-run family/style overrides so inline `code` measures at its own metrics, `warnUnmeasured` (`:9`) one-shot warning gated by `unmeasuredGlyphCount`); `TextStyle` (`:113`, ~9 fields: `fontSize/color/bold/italic/fontFamily/lineThrough/baselineShift/underline/highlightColor/abbrTitle/href` — every advance-affecting one must be in `styleSig`; `fontFamily` was missing until 2026-07-30 and caused `monospace` paragraphs to be served `serif` metrics at infinite cache hit rate, latent only because the pre-fix empty-atlas churn kept `paragraphCache` at 0 hits); `InlineObject` (`:216`, `OBJECT_REPLACEMENT U+FFFC :198`, fixed `width/height/depth/alt/key/paint` `:216`, `width/height/depth` already resolved to px, `paint` (`:301` `InlineObjectSurface { drawImage, drawImageRect } :315`) never called by the engine, `InlineObjectBox { x,y,width,height } :299` already includes `depth`); `cacheStats()` (`:1004`) exposing `hits/misses/evictions/hitRate/size/capacity` per `word(500)/grapheme(2000)/paragraph(1000)/richParagraph(1000)` (`:831` caps) with `resetCacheStats()` (`:1030`) preserving entries; `LayoutResult` (`:378` `nodes/totalWidth/totalHeight/fallbackToCanvas`) is the sole output of every hot path; `GridTextEntity` (`components/GridTextEntity.ts:4`, legacy `n`) vs `PreparedContentGrid.ts:243` split makes explicit which grid is retained and which is a dumb `fillText` loop.

Hot-pass placement in code terms: inside `layoutPrepared` (`LayoutEngine.ts:2050`ff) the per-paragraph `pMax` is first grown for objects (`objDescent`/`ascent > pMax*0.8` → `pMax = ascent/0.8`) then `lineHeight = max(pMax*1.5, pMax*0.8+objDescent)` drives `computeLineSegments` / `startLine` (`:2004`), followed by a wordQueue walk (`:2109`) with hyphen-prefix splitting (`:2123` `chosen`/`prefixWidth`/`hyphenWidth`) and a glyph loop (`:2159`) whose `y` placement (`:2183`) is three arms: object (`currentY + pMax*0.8 - (height-depth)`), baseline-shifted (`currentY + (pMax-gfs)*0.8 - baselineShift`), plain (`currentY + (pMax-gfs)*0.8`). `exclusionMask` (`:2155`) and leading-space suppression (`preserveLeadingSpaces` `:796`, `:2180`) are per-glyph; `msdfLayout.ts:154` mirrors the same three arms minus exclusions.

Supporting contracts worth knowing by `file:line`:

- `GlyphAtlas` (`LayoutEngine.ts:58`, `width/baseSize/ast`) and `EMPTY_GLYPH_ATLAS` vs a fresh `{}` literal for paragraph memo identity (`:83`).
- `PreparedGlyph` (`:402`, `char/width/style/object/level/sourceIndex/sourceLength/atlasMiss`) — `atlasMiss:true` only when `char.trim().length>0 && !hasGlyph`, so whitespace never marks fallback (`:1134` in `prepare`).
- `PreparedWord` (`:433`, `glyphs/width/isWordLike/isWhitespace/breakPoints`) — `width` is cached sum, `breakPoints` from soft hyphens or `hyphenate`.
- `ExclusionRect` (`:482`) + `computeLineSegments` (`:504`) — `O(n log n)` complement of covered x-intervals, per line.
- `LayoutEngine.isComplexScript` (`:584`, conservative — over-reports so only plainly context-free text qualifies for suffix-only shaping) and `splitParagraphs` (`:566`, `\r\n|\r|\n`, `consumed` keeps source offsets exact so CRLF `\r` never becomes a tofu glyph).
- `shiftedExtent` (`:668`) shared by all three `pMax` walks — line grow logic must never diverge.
- `suppressLineBreaks` (`:721`, GH-457 `'@'` join + closing-punct `.:,;)]}!?` merge with `breakPoints` rebase).
- `LayoutBuffer` (`:2449`, `{ glyphs: PositionedGlyph[], widths: Float32Array, levels: Uint8Array }` for `layoutPreparedIntoBuffer` `:2241`, the `V8_SMI_MAX`-bounded typed-array path that enforces measure/paint agreement at the call site).

### 2.8b Line breaking, exclusion flow, and justification — the hot-pass placement rules

The hot pass is where `PreparedText` becomes `x/y`. Three pure functions outside the engine and one method inside govern every wrap decision; they must agree between `LayoutEngine` (`packages/layout/src/LayoutEngine.ts`) and `msdfLayout` (`packages/layout/src/msdfLayout.ts`) or GPU and canvas breaks diverge.

- **`computeLineSegments(top, bottom, maxWidth, exclusions)` (`LayoutEngine.ts:504`)** — the testable core of exclusion flow. `ExclusionRect { x,y,width,height }` (`:482`) and `LineSegment { x0,x1 }` (`:490`) are the only types. Pure `O(n log n)` (sort blocks) / `O(n)` space: collect x-intervals of `exclusions` overlapping `[top,bottom)` clamped to `[0,maxWidth]`, merge touching/overlapping intervals, complement within `[0,maxWidth]`. Returns `[{0,maxWidth}]` when nothing overlaps, `[]` when a rect (or union) spans the width. Time per line, not per glyph — called once per `currentY` advance inside `layoutPrepared` (`:2004` `segs = computeLineSegments(currentY, currentY+lineHeight, maxWidth, exclusions)`). `hasEx` guard (`LayoutEngine.ts:1860`) shunts the non-exclusion path (single full-width segment) so the common case pays no allocation.

- **`suppressLineBreaks(words)` (`LayoutEngine.ts:721`)** — GH-457 pre-merge before placement. Rule 1: `'@'` (`glyphs.length===1 && char==='@'`) merges with every following non-whitespace word (`"@vectojs/core"` stays atomic). Rule 2: closing punct `.:,; ) ] } ! ?` never starts a line — merged backward onto the preceding non-whitespace word (skipping whitespace words, so `"word !"` does not make a `" !"` pseudo-word). Must rebase `breakPoints: number[]` on merge (`:732` `+ offset`, `:791` `+ prev.glyphs.length`) or soft-hyphen opportunities land at wrong glyph indices downstream. Mirrored in `msdfLayout.ts:195` `isOrphanPunct` / `breakableAnywhere` (CJK `code >= 0x2e80`) logic.

- **Hyphenation** — two sources filling the same `PreparedWord.breakPoints: number[]` (`LayoutEngine.ts:441`): soft hyphens `U+00AD` in source are invisible break opportunities (consumed in the grapheme loop `:1134` `(breakPoints ??= []).push(glyphs.length)` with no advance), and the pluggable `LayoutEngine.hyphenate: (word)=>string[]` (`:880`) is consulted per `isWordLike && glyphs.length>3` word (`:1144`) — its parts are re-segmented through `getGraphemes` to count graphemes, not code units. `hyphenWidth` (`:490`, advance of `'-'` via `glyphWidth`) is measured once per `PreparedText` only when some word carries `breakPoints` (miss costs no measure, and in a metrics-less node does not increment `unmeasuredGlyphs`). At wrap time, the engine prefers soft breaks (`softBreaks: {at,x}[]` in `msdfLayout.ts:131`) then falls back to hyphenated split emitting a `'-'` quad (`msdfLayout.ts:167` `emitHyphen`). `MSDFTextEntity` drives hyphenation on the main thread via annotated `layoutText`; the worker never calls the callback.

- **`shiftedExtent(gfs, shift, pMax)` (`LayoutEngine.ts:668`)** — shared by all three `pMax` walks (`measurePrepared`, `layoutPrepared`, `layoutPreparedIntoBuffer`) so line height can never diverge. Line box is `1.5 * pMax` tall with baseline `0.8 * pMax` (same split as `Typography.ts:93`). Raised run (`shift>0`, CSS `vertical-align` positive-up, superscript): `need = shift + 0.8*gfs` must fit `0.8*pMax`; lowered (`shift<0`, subscript, opposite sign to `InlineObject.depth`): `need = -shift + 0.2*gfs` must fit `0.7*pMax`. Example: `0.75em` supershift `~0.3em` fits inside the `0.8*(pMax-gfs)` slack and grows nothing; a far shift grows `pMax` to `need/0.8` or `need/0.7`. Every justification pass and exclusion advance recomputes against the final `pMax`.

- **`justifyLines(wrapClosedLines, lineOf, xCoords, codePoints, advances, maxWidth, maxLineWidth)` (`msdfLayout.ts:11` + `LayoutEngine.ts:1937`)** — stretches every soft-wrapped line flush to `maxWidth`. Strategy: group `indices` by `lineOf`, skip `wrapClosedLines` miss (last line of each paragraph, explicit newline, and `hitMaxHeight` truncation), then `slack = maxWidth - (xCoords[lastIdx]+advances[lastIdx])` capped at half the line span (guards against grotesque stretch on very short lines). Space-ful lines widen inter-word `0x20` gaps equally (`extra = slack / spaceIdx.length`, `shift` accumulator `:58`); space-less CJK lines distribute `slack / lastContent` between every glyph (`:70`). Multi-run exclusion lines are not justified (`LayoutEngine.ts:1937` single-run guard). Must mirror between `LayoutEngine` and `msdfLayout` — justified width is the contract content projection reuses for `positionedRuns` vs `logicalRuns`.

### 2.9 `packages/layout/src/measure.ts:39` — measurer selection

- `createCanvasMeasurer(family, baseSize=100)` (`:39`) — `getSharedMeasuringContext()` (`:44`), `Map<string,number>` per-grapheme cache at `baseSize`, linear scaling `base * (size/baseSize)` (`:68`). Per-run `family/bold/italic` keys prevent poison.
- `createMetricsMeasurer(family)` (`:96`) — registered `FontMetricsSource` (`:106` lazy resolve with versioned `fontMetricsVersion` compare, `+13%` overhead for per-glyph lookup avoided on every call vs allocating inside `normalizeFamily`). Per-run `family` override falls back to base source when unregistered for that run, not to `0.5em`. Bold/italic intentionally ignored (single advance table per family).
- `resolveGlyphMeasurer` (`:161`) — canvas wins over metrics over `null` by design: it measures what the renderer draws, including synthesized weight; a stale registration must not override ground truth.

### 2.10 `packages/layout/src/msdfLayout.ts:93` — MSDF word-wrap for the worker

Pure function `computeMSDFLayout(request, font)` (`:93`) shared by worker and main-thread fallback (no import at runtime — esbuild inlines it into `LayoutWorker.ts` via `LayoutWorkerSource.ts` — so the main-thread fallback cannot diverge from the worker). Flat-array counterpart of `LayoutEngine.layoutPrepared` without exclusions / per-glyph collision callback / rich styles: consumes `font.glyphs[].advance/kerning` (`byCode/kern`), `metrics{ascender,descender,lineHeight}` (fallback `0.8/-0.2` when absent `:118`), `atlas` `aw/ah/yOrigin` (`:103`) for UV geometry, but never reads `planeBounds/atlasBounds` — those belong to `MSDFFont.layout` back on the core side. Walks `Array.from(text)` (`:176`, codepoint-safe), advances `curX` per glyph with `kernKey(prevCode,code)` (`:192` `+ k*fontSize`) + `letterSpacing` (`:121`), nonspacing-mark zero-advance mirroring `MSDFFont.ts:132`, hyphen/orphan-punct `isOrphanPunct` (`:201`, same set as `suppressLineBreaks`) and `breakableAnywhere` (`:195`, CJK `>=0x2e80`), `wrapClosedLines: Set<number>`, `softBreaks: {at,x}[]` (`:131`), `lineOf: number[]` (`:107`), `xCoords/yCoords: number[]`, `packedStyles: number[]` (`:104`, packed `TextStyle` bits), `advances: number[]` (`:110`), `codePoints: number[]` (`:101`), `maxLineWidth` (`:114`). On wrap (`breakLine` `:140`, `dropFrom` `:155`, `emitHyphen` `:167`), `justifyLines(wrapClosedLines, lineOf, xCoords, codePoints, advances, maxWidth, maxLineWidth)` (`:11`) stretches inter-word `SPACE(32)` gaps (`:44`) or on space-less CJK distributes `slack/lastContent` between every glyph (`:70`), both capped at half the line span to avoid grotesque stretch on very short wraps.

### 2.11 Worker off-thread model

**Boundary**: `LayoutWorker.ts:4` (`LayoutWorkerRequest`: `id/seqId/text/fontId/fontData/maxWidth/maxHeight/fontSize/lineHeight/letterSpacing/textAlign`) and `LayoutWorkerResponse` (`:24`: `id/seqId/width/height + Uint32Array codePoints / Float32Array xCoords/yCoords / Uint32Array packedStyles + error?:string`); transferable buffers in `postMessage` (`LayoutWorker.ts:111`).

**Worker**: `packages/layout/src/LayoutWorker.ts:1` — ~115 lines, `fontCache: Map<string,MSDFFontData>` (`:42`), `isLayoutWorkerRequest` validation (`:53`), `isExpectedOrigin` (`:48`), `self.onmessage` (`:76`) → `fontCache.set` → `computeMSDFLayout(request, font)` → `postMessage(response, [codePoints.buffer, xCoords.buffer, yCoords.buffer, packedStyles.buffer])`. Unknown font → error-shaped zero-length response (`LayoutWorker.ts:92`) rather than silent drop.

**Manager**: `packages/layout/src/LayoutWorkerManager.ts:28` — singleton (`getInstance` `:206`), `createWorker` (`:67`) via `new Blob([WORKER_SOURCE_STRING])` + `URL.createObjectURL` (`LayoutWorkerSource.ts`; mirrors `MarkdownWorker` CSP guard: `typeof Worker/Blob/URL` absent → `null` → main-thread fallback, not a throw). `onmessage` matches `${id}-${seqId}` (`:99`) against `pendingCallbacks: Map<string,PendingLayout>` (`:34`), resets `consecutiveWorkerFailures` (`:109`). `onerror/onmessageerror` → `handleWorkerFailure` (`:120`), `MAX_CONSECUTIVE_WORKER_FAILURES=2` (`:19`) then `workerUnavailable=true` → stay on main thread (CSP `worker-src 'none'` measured 2026-07-31: six `queueLayout` calls spawned six Workers, zero layouts). `fontDataById` (`:043`, retained for lifetime, distinct from `registeredFonts` cleared on worker death) lets fallback layout work when callers pass `fontData` only once. `warnedUnknownFonts` (`:049`) silences repeated console warnings. `queueLayout(entityId, opts, callback)` (`:224`) debounces 50 ms (`:314` `setTimeout(runLayout,50)`) and compares `seqIdCounter` so late replies are ignored; `cancelLayout/cancelLayoutForEntity` (`:220`/`:319`) drains timers and `prefix === ${entityId}-` pending map entries. `resolvePendingOnMainThread` (`:144`) replays every pending `computeMSDFLayout` directly when the worker dies. `errorResponse` (`:176`) synthesizes the unknown-font reply shape.

**Consumer**: `packages/core/src/text/MSDFTextEntity.ts:25` — `queueLayout()` (`:204`) calls `LayoutWorkerManager.getInstance().queueLayout(this.id, { id, seqId: ++seqId, text: layoutText, fontId: font.id, fontData: font.data, maxWidth/maxHeight/fontSize/lineHeight/letterSpacing/textAlign }, cb)`; `seqId` monotonic per entity, `lastRenderedSeqId` (`:048`) drops stale replies, `contentEpoch` (`:051`) skips unchanged syncs, `rebuildProjectionLines()` (`:273`) rebuilds `projectionLines: ContentProjectionLine[]` for `getContentProjection()` (`:248`). Hyphenator runs on main thread (can't be cloned into worker) by annotating `layoutText` with `U+00AD`. `watchAtlasDecode` (`:106`) waits for atlas image decode; `SVGEntity.ts` is the sibling non-text entity.

### 2.12 Benchmarks, comparisons, and how the numbers are produced

Text layout has two honest costs: **cold** (segment+measure) and **hot** (place). Comparing a combined cold+hot call to a hot one invents a gap. The repo enforces the apples-to-apples split in three places:

- **`benchmarks/text-layout-pretext`** and **`comparisons/text-layout-pretext/*`** (`entry.ts:1`, `page/*`, `serve.ts`, `build.ts`) — `@vectojs/layout` vs `@chenglou/pretext`. Both measure via `canvas measureText` in a real browser (see `comparisons/text-layout-pretext/entry.ts:1` header: V8 vs Gecko differ and only a headed headed GPU-backed window is quotable — `hyprland-browser-bench` owns that harness). `prepare` vs `prepareWithSegments` (cold) and `measurePrepared` vs `layout` (hot) are the only comparable halves; `layoutPrepared` / `layoutText` (which positions every glyph) have no pretext counterpart and are reported separately.
- **`scripts/compare-pretext.ts:1`** — the headless counterpart run by `benchmarks/bench.ts`. Bundles `vectojs core` + `pretext` to IIFE via `Bun.build`, injects into Playwright-controlled Chrome, establishes DOM truth via `Range.getClientRects().length` per corpus/font, then reports line-count error vs truth plus cold/hot throughput. Documents its own history: until 2026-08-04 it timed our combined `layoutText()` against pretext's hot `layout()` and was flagged in `vectojs-docs/testing-catalog.md:A6` as "not yet apples-to-apples."
- **`vectojs-docs/forge/baselines/*`** — the semi-official baselines the harness produces (`glyph-batch-*.json`, `content-projection-frontload-*.json`, etc.). Not all are text-layout: `glyph-batch` is the WebGL glyph-upload cost that shares the `LayoutBuffer` width path, and `markdown-stream-*` capture lex+layout interaction during streaming. Each carries `commit`, CPU/GPU/driver env, and `refreshHz` via `benchmarks/run-browsers.sh` so a later comparison can normalize.

**How to re-run locally** (headless, non-quotable but regression-useful): `bun run scripts/compare-pretext.ts` (Playwright + `google-chrome-stable`) prints a markdown table and writes `scripts/.compare-results.json`. For quotable numbers: `benchmarks/run-browsers.sh` from the workspace root (drives real Chrome/Firefox on the dedicated Hyprland workspace, validates COOP/COEP, starvation detection).

## 3. How it composes under `packages/core`

`MSDFTextEntity.text` → `rebuildLayoutText()` (`:187`, annotates soft hyphens) → `queueLayout()` (50 ms debounce) → `LayoutWorkerManager` (worker or main thread) → `computeMSDFLayout` → typed arrays → `MSDFTextEntity.layoutResult` + `projectionLines` → WebGL `setMSDFTexture`/`addGlyph` per `PositionedGlyph`, `getContentProjection().lines` for a11y, `CanvasGeometry` DPR compensation.

`Text`/`RichText` (`@vectojs/ui`) go through `LayoutEngine` + `measureContext` directly (canvas path). Same invariants, different measurer.

### 2.13 The `GridTextEntity` footnote — retained grid vs retained prose

`packages/core/src/components/GridTextEntity.ts:4` (`class n extends Entity`, `GridTextEntity`) is the legacy monospace grid entity (fixed `charWidth/charHeight`, `updateGrid(ascii[])` `:23`, `render` `:36`). It predates `prepareContentGrid` and does **not** flow bidi, shape Arabic, or honor `PreparedContentGrid` — it is a direct `IRenderer.fillText` loop (`:44`) over an `ascii: string[]`. The modern replacement for anything requiring bidi/CJK/grid a11y is `prepareContentGrid` (`packages/text/src/PreparedContentGrid.ts:243`) with its content-grid projection (`01-selection.md` §3.3). `GridTextEntity` remains as the "dumbest thing that paints monospace" and surfaces in `packages/core/test/GridTextEntity.test.ts` and `packages/core/src/index.ts:n`.

## 4. Hard cases — measured failures

### 4.1 Detached canvas font resolution (Firefox-only)

Greppable as `Intl.Segmenter` (word `:916` / grapheme `:917` in `LayoutEngine.ts`, `:76` in `PreparedContentGrid.ts`), `BidiResolver` / `BiDi` (`BidiResolver.ts:3` `bidi-js`), `registerFontMetrics` (`fontMetrics.ts:82`, called directly in `Typography.ts:67` via `getFontMetrics` and indirectly from `measure.ts:75`), `cold/hot split` (`LayoutEngine.ts:459`–`1848`, commented with ** and `measurePrepared` / `layoutPrepared` / `layoutPreparedIntoBuffer` triptych), and `zero-GC` (`LayoutEngine.ts:2241` `layoutPreparedIntoBuffer` + `msdfLayout.ts:1` flat arrays + `BidiResolver.reorderSegments` `:121`). Auditing exclusion flow is `computeLineSegments` `:504` and `ExclusionRect` `:482`; DPR quantization is `PAGE_SCALE_BASIS_PX = 256` (`ContentProjectionManager.ts:71`).

See §2.3 table (`packages/text/src/measureContext.ts:18`): monolithic advances 20–47% short. Fix is attachment; residual 0.3% (`131.579` vs `132.000`) is Gecko grid-fit to integer device px, not escapable (`text-rendering: geometricPrecision` measured identical, `:34`). Audit by searching for detached canvas creation (`grep -rn 'createElement.*canvas'` `packages/`). `OffscreenCanvas` is not the fix — it agrees with DOM layout (`132.000`) rather than the painted canvas (`131.579`).

### 4.2 CJK vs Latin metrics

`0.5em` fallback measured `+125%` error on narrow glyphs and `-47%` on wide against Chrome at 32 px (`packages/layout/src/LayoutEngine.ts:973` comment). `EMPTY_GLYPH_ATLAS` (`:83`) with a real `resolveGlyphMeasurer` cures line-break error; `createMetricsMeasurer` with registered `MSDFFont` cures SSR/headless. Mixed `CJK | Latin` in one paragraph lands in the same `layoutPrepared` run; `GlyphMeasurer` keys per-run `fontFamily/bold/italic` so `monospace` inside proportional uses its own advances, and `styleSig` includes every advance-affecting `TextStyle` field.

### 4.3 BiDi reordering vs selection order

`reorderIndices` is the bridge: logical→visual (`logicalToVisualRuns` `:62`) for highlight rects, visual-column→logical for hit testing, `reorderVisual` (`:89`) for paint order. `PreparedContentGrid` keeps `cells` in logical order with visual `x` (`packages/text/src/PreparedContentGrid.ts:315`); selection offsets are source (logical) offsets, not visual indices. See `tmp/boss-research/01-selection.md` §3.2/§4.1 for the per-grapheme carrier + `shapedPaint` half of this contract and `forge/findings/text-richtext-and-markdown.md:356` (InlineObject) for where `buildVisualLineGroups` grouped by `node.y + height*0.8` and split a chip into its own line.

### 4.4 Mixed font fallback in one paragraph

A paragraph styled `family: 'Noto Sans'` with a `family:'monospace'` code span. `GlyphMeasurer.measure(char,size,'monospace')` (`packages/layout/src/measure.ts:60`) measures at that family; unknown run family falls back to base source, not `0.5em` (`:138`). Paragraph memo `styleSig` includes `fontFamily` (was missing until 2026-07-30, latent only because the empty-atlas churn kept the cache at 0 hits). Test: `benchmarks/text-layout-pretext` / `comparisons/text-layout-pretext` and `scripts/compare-pretext.ts:1` (cold/hot apples-to-apples with `Range.getClientRects` line-count truth).

### 4.5 DPR-sensitive advances

Canvas advances grid-fit to device px; `LayoutEngine` `shiftedExtent` / `cssLineBoxBaseline` use the `0.8` ascent ratio independent of DPR. CodeBlock atlas once captured `devicePixelRatio` at first construction (`packages/markdown/src/Markdown.ts:1358`, `GlyphRasterAtlas.ts:139` `readonly dpr`) and blurred after zoom (`forge/findings/text-richtext-and-markdown.md:724`, `sceneDpr 4.286 / atlasDpr 1.579 → blitScale 2.71`). Fix: feed `Scene.watchDevicePixelRatio()` (`Scene.ts:2805`) into atlas DPR. Re-verify via `maxGradient` (peak edge), not mean luminance (confounded by thin mono glyphs, measured `0.216→0.251` the wrong way at a 2.71× mismatch). DPR clamping `min(dpr,3)` at `Atlas.ts:139` is a separate ceiling — even a correct rebuild cannot exceed 3 on a `4.286` panel.

### 4.6 Line ending ownership and CRLF phantom glyphs

`splitParagraphs` (`LayoutEngine.ts:566`) regex `/\r\n|[\r\n]/g` and `MSDFFont.layout` (`MSDFFont.ts:213`) both consume the separator **before** any `ArabicShaper`/`BidiResolver`/`glyphWidth` step and record `consumed` (`:569` `m[0].length`) for `sourceIndex` continuity. A naive `text.split('\n')` leaves `\r` as the last character of the paragraph: it is shaped, measured, and placed as a visible tofu with width `missingAdvance*size`, and every later `sourceIndex` is off by one per CRLF. `PreparedContentGrid.sourceLines` (`:197`) carries the same contract (`sourceEnd` excludes the break, `nextSourceStart` owns it) and additionally inserts an explicit trailing empty line when `source` ends with a break (`:217` `if (start===source.length)`). Test: `benchmarks/text-layout-pretext` normalizes source to `\n` for DOM truth but measures raw source separately; parity means raw `"\r\n"` source produces identical `totalHeight` and `sourceIndex` coverage as `"\n"` source, just with `sourceLength` gap of 1 per line.

### 4.7 Hyphenation + orphan-punct + justification must compose in order

Cold: soft hyphen `U+00AD` (`LayoutEngine.ts:1134`) and `hyphenate` callback (`:1144`) both contribute to `PreparedWord.breakPoints` (`:441`); `hyphenWidth` (`:490`) is measured once only for words that have any. Hot: `suppressLineBreaks` (`:721`) rebases `breakPoints` on merge so a hyphen split inside `"@vectojs/core"` doesn't land in the middle of the now-atomic token; the word-queue walk (`:2109`ff) prefers a prefix hyphen (`chosen` scan `:2133`) before falling back to whole-word wrap. Consequence: `wrapClosedLines` (`msdfLayout.ts:125`) and `justifyLines` (`:11`) both read the final break decision, so fixing one without the other produces a justified line whose measured width (for projection) disagrees with its placed `x` (for ink). Both `LayoutEngine` and `msdfLayout` duplicate the hyphen `+ letterSpacing` + orphan logic — change one without the other is the common regression.

## 5. Invariants developers must keep

1. **Measure where you paint.** Use `getSharedMeasuringContext()` (`packages/text/src/measureContext.ts:87`). Grep for stray `document.createElement('canvas')` without `appendChild`.
2. **Cold before hot, never re-segment for a DOM.** `prepare`/`prepareRich` once, `layoutPrepared` many times (`packages/layout/src/LayoutEngine.ts:1080` `/` `:1266` `/` `:1848`). Re-segmenting shifts breaks and bidi order.
3. **Every advance-affecting field in `styleSig`.** If it reaches `glyphWidth` it reaches `styleSig`/`fingerprint` (`:1266:styleSig`). Omitting one is latent until the paragraph caches restore hit rate.
4. **`InlineObject` identity includes `key`.** Two `U+FFFC`s with same `alt/width/height` but different `paint` must differ on `key` or the second paints the first image (`packages/layout/src/LayoutEngine.ts:268`).
5. **Worker is an optimization, never a requirement.** `LayoutWorkerManager` degrades to `computeMSDFLayout` on the calling thread (`:144`) after two consecutive failures or absent `Worker`. Unknown font → typed error, never a hung callback (`:176`).
6. **`indexMap` and `sourceIndex` stay byte-faithful.** Arabic shaping index map (`packages/text/src/ArabicShaper.ts:91`) is the source of truth; `LayoutNode.sourceIndex/sourceLength` index the original string, not shaped text, so accessibility can substitute `InlineObject.alt` without shifting later offsets (`forge/findings/text-richtext-and-markdown.md:372`).
7. **Version the metrics registry.** `fontMetricsVersion()` (`packages/text/src/fontMetrics.ts:64`) must be read before caching a `FontMetricsSource`; replacing a family's metrics mid-process is a real codepath (webfont swap, corrected data).
8. **`0.5em` means unmeasured — count it.** Watch `unmeasuredGlyphCount()` (`packages/layout/src/LayoutEngine.ts:31`) in tests/SSR; non-zero means fabricated breaks, not just missing-atlas glyphs (`fallbackToCanvas` is true on essentially every `Text`/`RichText` paragraph and says nothing about quality).

## 6. How to add a new script or style without breaking metrics parity

**New script (e.g., Thai, Devanagari):**

1. Run `isComplexScript` (`packages/layout/src/LayoutEngine.ts:584`) against a corpus — the predicate gates the streaming `shapeSimpleRun` shortcut (`:1358`). Any context-sensitive script must return `true` so the paragraph takes the full `shapeArabic`+`BidiResolver` path; otherwise the suffix-only reshaper shapes graphemes independently and silently disconnects joining text.
2. If marks are TRANSPARENT for shaping, add them to `ArabicShaper.isHarakat` (`:70`) and `MSDFFont.isNonspacingMark` (`:132`) together — they are leaf packages that must agree.
3. Add advance coverage: either MSDF atlas glyphs for the script or registered metrics (`registerMSDFFontMetrics`, `packages/text/src/fontMetrics.ts:97`). Without either, `unmeasuredGlyphs` counts every character and breaks are `0.5em` guesses.
4. Verify with `auditSceneSelection` (`packages/devtools/src/selectionAudit.ts`) on a line mixing the new script with CJK+Latin — the gap budget is `PAGE_SCALE_BASIS_PX = 256` quantization (`ContentProjectionManager.ts:71`), so a script that changes advance per neighbour is invisible there.

**New `TextStyle` field:**

1. Ask: "does it change `glyphWidth`?" If the renderer paints it as an offset / decoration without changing the reserved advance (`underline`, `lineThrough`, `highlightColor`), no parity work. If it changes the measured advance (`fontSize`, `fontFamily`, `bold`, `italic`, anything that selects a different `measure` path), it must be included in `styleSig`/`fingerprint` (`packages/layout/src/LayoutEngine.ts:1266`) and in `styleRangeEquals` (`:682`).
2. Add the field to the style equality and signature together — testing only one leaves the other as a memo poison (different paragraphs collide, same paragraph never hits).
3. Add `baselineShift`-style vertical growth via `shiftedExtent` (`:668`) if the field moves glyphs vertically outside `0.8 * pMax` (ascent) / `0.7 * pMax` (descent); all three `pMax` walks must call it.

**New line-breaking rule:**

- Lives in `suppressLineBreaks` (`:721`) or `justifyLines` (`packages/layout/src/msdfLayout.ts:11`). Keep the hyphenation `breakPoints` shifted on merge (`:732` `+ offset`, `:791` `+ glyphs.length`). Wrap-state (`wrapClosedLines`, `lineOf`, `softBreaks`) is duplicated between `LayoutEngine` and `msdfLayout` — change both.

### 4.8 Vertical mixed — `baselineShift` and inline objects

**`TextStyle.baselineShift` (`LayoutEngine.ts:146`, px, `positive = UP`, CSS `vertical-align` convention)** — render-only horizontally (advance unchanged) but a measurement change vertically. Values modest enough to fit the `0.8/0.7 * pMax` slack leave the line height untouched (a `0.75em` superscript `+0.22em` is the common case); a shift that would place a glyph outside the line box drives `shiftedExtent` (`:668`) to grow `pMax`, and the grown value propagates into every `currentY` advance and `computeLineSegments` call — so the space between _this_ line and the next widens, exactly as a tall inline object would force. Callers must not reserve vertical space themselves; the engine does it once, in one place, or the three `pMax` walks disagree and `measurePrepared` reports a different height than `layoutPrepared` paints.

**`InlineObject` (`LayoutEngine.ts:216`, `StyledSpan.object` `:343` requires `text===OBJECT_REPLACEMENT`)** — three numbers, all **px at final size** (not scaled by run `fontSize`, unlike glyph advances): `width` (horizontal advance), `height` (total box), `depth` (below baseline, positive-down — opposite sign to `baselineShift`). The engine reserves `width`, accounts `height/depth` in `shiftedExtent` growth, and reports the positioned `LayoutNode.object` box (`x/y` already includes `depth`); it never calls `object.paint(surface, box)` (`:301`) — the text renderer does once per `LayoutNode.object`. Pitfall: `alt` reaches accessibility via `RichText.accessibleText` (`collectSpans` substitutes `alt` for `U+FFFC`) but `copy/selection` still indexes by the one-char sentinel in `sourceText` space, so `alt` length does not shift later `sourceIndex` arithmetic. A second pitfall with the same symptom: `paint` is **not** part of the paragraph memo key (a closure per call would keep it at 0 hits forever) — the surrogate `InlineObject.key` (`:259`) must differ when `paint` differs, or two badges with same `alt` share a cached paragraph and the second draws the first image (re-observed `forge/findings/text-richtext-and-markdown.md` a11y/InlineObject entries).

### 4.9 Streaming cost and why suffix-only shaping is not where the time goes

`LayoutEngine.streamShapeCache` (`:839`, `isComplexScript` `:584` gate, `shapeSimpleRun` `:1644`) was introduced alongside the paragraph memo (`:829`/`833`) to cut per-chunk cost from `O(length)` to `O(appended)` on a growing Markdown block (`Markdown.ts:899` streaming `appendMarkdown`). Measured on the 346 KB synthetic doc (`forge/findings/text-richtext-and-markdown.md:356`): **identical cost 2630 ms vs 2639 ms**. Real Markdown has bounded paragraphs — the existing memo already caps per-paragraph reshaping — so suffix-only shaping only helps pathological single huge paragraphs. The finding stayed shipped as a correctness win (its `isComplexScript` predicate and `styleRangeEquals`/`objectRangeEquals` checks prevent silent joining-text disconnect) but was **not** published as a performance fix in a standalone `@vectojs/core` release. When diagnosing streaming time, `prepareRich` + `measureText` + content-projection sync (`forge/findings` 2026-07-20 entry: `perf.ts` `requestAnimationFrame` delta) matter; MSDF changes glyph _drawing_ and `64fps→120Hz` is a separate path.

## 5. Invariants developers must keep

1. **Measure where you paint.** Use `getSharedMeasuringContext()` (`packages/text/src/measureContext.ts:87`). Grep for stray `document.createElement('canvas')` without `appendChild`.
2. **Cold before hot, never re-segment for a DOM.** `prepare`/`prepareRich` once, `layoutPrepared` many times (`packages/layout/src/LayoutEngine.ts:1080` `/` `:1266` `/` `:1848`). Re-segmenting shifts breaks and bidi order.
3. **Every advance-affecting field in `styleSig`.** If it reaches `glyphWidth` it reaches `styleSig`/`fingerprint` (`:1266:styleSig`). Omitting one is latent until the paragraph caches restore hit rate.
4. **`InlineObject` identity includes `key`.** Two `U+FFFC`s with same `alt/width/height` but different `paint` must differ on `key` or the second paints the first image (`packages/layout/src/LayoutEngine.ts:268`).
5. **Worker is an optimization, never a requirement.** `LayoutWorkerManager` degrades to `computeMSDFLayout` on the calling thread (`:144`) after two consecutive failures or absent `Worker`. Unknown font → typed error, never a hung callback (`:176`).
6. **`indexMap` and `sourceIndex` stay byte-faithful.** Arabic shaping index map (`packages/text/src/ArabicShaper.ts:91`) is the source of truth; `LayoutNode.sourceIndex/sourceLength` index the original string, not shaped text, so accessibility can substitute `InlineObject.alt` without shifting later offsets (`forge/findings/text-richtext-and-markdown.md:372`).
7. **Version the metrics registry.** `fontMetricsVersion()` (`packages/text/src/fontMetrics.ts:64`) must be read before caching a `FontMetricsSource`; replacing a family's metrics mid-process is a real codepath (webfont swap, corrected data).
8. **`0.5em` means unmeasured — count it.** Watch `unmeasuredGlyphCount()` (`packages/layout/src/LayoutEngine.ts:31`) in tests/SSR; non-zero means fabricated breaks, not just missing-atlas glyphs (`fallbackToCanvas` is true on essentially every `Text`/`RichText` paragraph and says nothing about quality).
9. **`\r` and CRLF are never shaped.** `splitParagraphs` (`LayoutEngine.ts:566`, `PreparedContentGrid.ts:197`) and `MSDFFont.layout` (`MSDFFont.ts:213`) both own line endings before any shape/measure step; a stray `\r` that slips through becomes a positioned glyph with phantom width and a wrong `sourceIndex`.
10. **Zero-GC mirrors allocating — keep the BiDi pass in sync.** `layoutPreparedIntoBuffer` (`:2241`) must apply the same `BidiResolver.reorderSegments` (`BidiResolver.ts:121` typed-array) permutation as `layoutPrepared`'s `reorderVisual` (`:89`), and must mirror `shiftedExtent`/`computeLineSegments`/`justifyLines`. Drift here is silent until a bidi paragraph is scrolled.

## 6. How to add a new script or style without breaking metrics parity

**New script (e.g., Thai, Devanagari):**

1. Run `isComplexScript` (`packages/layout/src/LayoutEngine.ts:584`) against a corpus — the predicate gates the streaming `shapeSimpleRun` shortcut (`:1358`). Any context-sensitive script must return `true` so the paragraph takes the full `shapeArabic`+`BidiResolver` path; otherwise the suffix-only reshaper shapes graphemes independently and silently disconnects joining text.
2. If marks are TRANSPARENT for shaping, add them to `ArabicShaper.isHarakat` (`:70`) and `MSDFFont.isNonspacingMark` (`:132`) together — they are leaf packages that must agree.
3. Add advance coverage: either MSDF atlas glyphs for the script or registered metrics (`registerMSDFFontMetrics`, `packages/text/src/fontMetrics.ts:97`). Without either, `unmeasuredGlyphs` counts every character and breaks are `0.5em` guesses.
4. Verify with `auditSceneSelection` (`packages/devtools/src/selectionAudit.ts`) on a line mixing the new script with CJK+Latin — the gap budget is `PAGE_SCALE_BASIS_PX = 256` quantization (`ContentProjectionManager.ts:71`), so a script that changes advance per neighbour is invisible there.

**New `TextStyle` field:**

1. Ask: "does it change `glyphWidth`?" If the renderer paints it as an offset / decoration without changing the reserved advance (`underline`, `lineThrough`, `highlightColor`), no parity work. If it changes the measured advance (`fontSize`, `fontFamily`, `bold`, `italic`, anything that selects a different `measure` path), it must be included in `styleSig`/`fingerprint` (`packages/layout/src/LayoutEngine.ts:1266`) and in `styleRangeEquals` (`:682`).
2. Add the field to the style equality and signature together — testing only one leaves the other as a memo poison (different paragraphs collide, same paragraph never hits).
3. Add `baselineShift`-style vertical growth via `shiftedExtent` (`:668`) if the field moves glyphs vertically outside `0.8 * pMax` (ascent) / `0.7 * pMax` (descent); all three `pMax` walks must call it.

**New line-breaking rule:**

- Lives in `suppressLineBreaks` (`:721`) or `justifyLines` (`packages/layout/src/msdfLayout.ts:11`). Keep the hyphenation `breakPoints` shifted on merge (`:732` `+ offset`, `:791` `+ glyphs.length`). Wrap-state (`wrapClosedLines`, `lineOf`, `softBreaks`) is duplicated between `LayoutEngine` and `msdfLayout` — change both.

## 7. Reading + verification checklist

**Reading order for a newcomer to this boss:**
`measureContext.ts:1` (invariant without which nothing else is honest) → `fontMetrics.ts:14` → `Typography.ts:93` → `BidiResolver.ts:27` + `ArabicShaper.ts:18` → `PreparedContentGrid.ts:38` (retained-grid counterpart) vs `components/GridTextEntity.ts:4` (legacy `n`) → `LayoutEngine.ts:916` (`Intl.Segmenter`) → `:929` (`glyphWidth`) → `:1080`/`1266` cold → `:1848` hot → `:504`/`:721`/`:668` placement rules → `measure.ts:39` → `MSDFFont.ts:151`/`msdfLayout.ts:93` → `LayoutWorker.ts:1`/`LayoutWorkerManager.ts:28` → `MSDFTextEntity.ts:25`. Cross-check with `01-selection.md` §§3–4 after `PreparedContentGrid` before returning to the prose hot path.

**Quick audit after any change that could move glyphs:**

- [ ] `unmeasuredGlyphs` (`LayoutEngine.ts:31`) still 0 on the touched workload (or the new marks are the cause and are now covered by `registerMSDFFontMetrics`).
- [ ] `cacheStats()` (`LayoutEngine.ts:1004`) `hitRate` did not drop to 0 — every advance-affecting style still in `styleSig`/`fingerprint` and `styleRangeEquals`/`objectRangeEquals`.
- [ ] `auditEntitySelection` / `auditSceneSelection` (`packages/devtools/src/selectionAudit.ts`) on a kerning-heavy line + a mixed CJK/emoji line + a bidi line — delta stays `<0.5px`.
- [ ] Worker fallback covered: `scripts/compare-pretext.ts:1` DOM truth (`Range.getClientRects` line count) still matches both cold (`prepare` / `prepareWithSegments`) and hot (`measurePrepared` / `layout`) paths.
- [ ] `\r\n` / lone `\r` document renders same line count as its `\n`-normalized twin — no phantom `\r` glyph and `sourceIndex` contiguous across CRLF.

## 8. Pointers

- Benchmarks: `benchmarks/text-layout-pretext` (`bench.ts`), `comparisons/text-layout-pretext/entry.ts:1` (`corpus()`, `buildAtlas()`, `preparePhase()`/`layoutPhase()`), `comparisons/text-layout-pretext/page/*`, `scripts/compare-pretext.ts:1` (cold/hot split, `Range.getClientRects` DOM truth, apples-to-apples `measurePrepared` vs `pretext.layout`; also the single-`CanvasRenderer`-counted lit-pixel sanity check, `forge/findings:text-richtext-and-markdown.md:564`, that warns not to double-count a second `CanvasRenderer` on one `Scene`).
- Baselines: `vectojs-docs/forge/baselines/*` (`glyph-batch-chrome-*.json`, `content-projection-frontload-*.json`, etc.) and `vectojs/benchmarks/bench.ts`. Each carries `commit`, CPU/GPU/driver, and `refreshHz` via `benchmarks/run-browsers.sh`.
- Findings (append-only, never rewrite): `vectojs-docs/forge/findings/text-richtext-and-markdown.md` (23 entries — detached canvas Firefox 2026-08-02 `:461`, `InlineObject.alt` never reaching AT `:364`, three GFM constructs silently discarded `:508`, codeblock DPR blur `:724`, streaming re-lex quadratic `:624`, suffix-only shaping negative result `:356` — identical cost `2630ms vs 2639ms` on realistic docs, bounded paragraphs).
- Grid path: `tmp/boss-research/01-selection.md` for the terminal/editor half and DPR quantization / overlay / per-grapheme-carrier details not repeated here.
- Entity layer: `packages/core/src/text/MSDFTextEntity.ts:25` + `SVGEntity.ts`, `packages/core/src/components/GridTextEntity.ts:4` (legacy `n`) vs `packages/text/src/PreparedContentGrid.ts:243` (retained grid), `references/text/pretext` read-only clone, `packages/layout/src/LayoutWorkerSource.ts` (generated, no edit), and `SPEC.md` for the canvas→GPU contract on `PositionedGlyph` quads. Direct benchmarks are comparative, not prescriptive — pretext is text-only, VectoJS feeds glyph + selection + a11y, so "which is faster at line-breaking" is fair and "which should I use" is not.
