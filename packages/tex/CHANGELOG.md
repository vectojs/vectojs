# @vectojs/tex

## 0.1.2

### Patch Changes

- 3410b81: Fixes #697: array vertical rules (`{c|c}`, `{c:c}`) now draw. Separator spans write their rule as `style.borderRightWidth`/`borderRightStyle`, which the emitter dropped — only `borderBottomWidth` rules survived #514's generalization. `.vertical-separator` spans now emit a stroked line centred on the column boundary spanning the table height (recovered from the span's `height` and `verticalAlign`), with a dash pattern for `:` separators, advancing nothing like their CSS border-box geometry.
- b585bae: Fixes #696: class-carried horizontal padding is now applied when measuring. `.x-arrow-pad`, `.cd-arrow-pad`, `.boxpad`, `.cancel-pad` and `.anglpad` carry their padding purely in katex.scss, so rows measured short by exactly that padding (`\xrightarrow{\text{very long label here}}` 5.858 → 6.558 em; `\boxed{x}` 0.572 → 1.172 em). The padding resolves against the carrying span's sizing ratio like every other em length. `.cancel-lap`'s −0.2em margins are applied with it so `\cancel` keeps its net advance while its ink window grows.
- d1f3c77: Fix stretchy overlay/clip render windows in SVG emit (#787, #788): `clipPath` rects are now emitted in the referencing path's own coordinate frame (SVG resolves them post-transform), and the aligned-vlist replay translates a recorded clip alongside the path it bounds. `\overbrace`/`\underbrace` middle and right pieces, nested `\phase`, and clipped radicals after a row advance or under a non-1 scale render their full visible window again instead of being displaced or partially eaten.
- 90ca1aa: Drift guards and edge-case fixes in the TeX emit layer (issue #611).

  `bun run vendor --check` now also verifies the constants `src/emit/`
  hand-transcribes from files it does not vendor: `$mu`, `$nulldelimiterspace`,
  both size-multiplier tables (`katex.scss $sizes` and `Options.ts
sizeMultipliers`), the `.katex` default font shorthand, the class-to-face font
  tables, and the vlist row-alignment classes. A new SCSS flattener re-derives
  each value from the upstream checkout on every vendor run in either mode, so a
  stylesheet change fails the run with a message naming both sides instead of
  shipping misplaced rules, delimiters or script sizes.

  `defineEnvironment` now passes through `argTypes`, `allowedInText` and
  `numOptionalArgs` (with upstream's documented defaults) instead of pinning them,
  so a future KaTeX bump that starts declaring these fields surfaces them in
  `_environments` rather than dropping them silently.

  Two glyph edge cases: a missing glyph whose font metrics are also missing no
  longer advances the pen by a non-finite width (which poisoned penX and the whole
  viewBox) — it degrades to zero advance with a once-per-glyph warning — and the
  glyph table's negative cache is bounded (FIFO, 1024 entries), so adversarial
  codepoints cannot grow memory unboundedly in long-lived SSR.

- 1796b63: Fixes #695: enclose boxes, borders and backgrounds now emit ink. `\boxed`, `\fbox`, `\fcolorbox`, `\angl` and `\colorbox` previously drew only their inner glyphs — the emitter handled `borderBottomWidth`/`katex-sout` rules alone and dropped every other border/background style the kernel writes. Border edges (`borderStyle`/`borderWidth` shorthands, `\angl` overrides, and the class-carried `.angl` 0.049em top/right defaults) are emitted as rects resolved against the enclosing vlist extent, and `\colorbox`/`\fcolorbox` backgrounds paint behind the glyphs in a new background layer.
- ff79c58: Fixes #666: glyph whitelist holes rendered common symbols as blank ink. The shipped subset was missing Main-Regular U+2248/`≈`, U+210F/`\hbar`, U+2113/`\ell`, U+211C/`\Re`, U+2026/`…`, the whole Script-Regular face (`\mathscr`), all Math-BoldItalic letters (`\boldsymbol`) and Main-Italic digits (`\mathit{123}`/`\textit{123}`) — layout advanced correctly, so these emitted correct-width blank gaps. The subset corpus now exercises every one of those ranges (569 → 662 glyphs, +87), and `glyphCoverage` pins each face so future subsetting cannot silently drop them again.
- ec6a80f: Fixes #667: `\phase` measured 400 em wide. Its angle SVG declares `width: "400em"` and the `hide-tail` wrapper writes only `style.height`, so — unlike `\sqrt`, which inlines a `minWidth` — no clip extent existed and the emitter advanced the full declared width. A hide-tail wrapper without an inline extent now records its child as a pending full-window overlay (left-aligned slice, like `\cancel`) resolved against the container extent: `\phase{-120}` measures 400.000 em → 2.807 em.
- 137b77e: Pin sliced-radical clip windows with renderer-geometry regression tests (#788): `\sqrt{x^2+y^2}` under a non-1 `sy` and `\frac{\sqrt{x}}{y}` (replayed aligned row, `sx = sy = 0.7`) now assert from the emitted SVG that the effective rendered window coincides with the path's own placement box. Also corrects the vlist replay soundness comment, which claimed clip translation was sound before it actually translated clips.
- d40c54f: Fixes #665: multi-piece stretchy overlays (`\overbrace`, `\underbrace`, `\xleftrightarrow`, …) measured 800–1200 em because each absolutely-positioned piece's declared `"width: 400em"` was taken as literal advance. Pieces of `.halfarrow-*`/`.brace-*` spans are now recorded as pending overlay paths that advance nothing and resolve their slice window (uniform cover scale, per-piece `preserveAspectRatio` alignment, clipped to the window) against the enclosing container extent once known. `\overbrace{x+y}` measures 1200.000 em → 2.320 em; `\sqrt` and other single-path `hide-tail` constructs are untouched.

## 0.1.1

### Patch Changes

- e41dd95: P3 review defects from the 2026-08-13 full-repo review (#499, #500).

  `@vectojs/tex`: `\llap`/`\clap` ink now lands where CSS puts it (llap ends at the anchor, clap straddles it) instead of all three laps sharing rlap's rightward draw; the emitted viewBox expands to the union of placed ink, so `\smash`/`\hphantom` content and `\llap` ink left of the origin are no longer clipped; and the `color` option (plus `\cancel` strokes and grouped fills) is attribute-escaped before interpolation, hardening the emitter against future user-derived colours.

  `@vectojs/markdown`: `inlineMathRasters` is now bounded — a render's raster is dropped when mathCache evicts the render, and the map is capped at the same 256 entries, evicting the least-recently-painted bitmap (re-decoding on the next paint) instead of growing unbounded in long-lived documents.

  `@vectojs/core` (WASM kernels): `particle_step` now mirrors the JS oracle's `Math.min`/`Math.max` NaN propagation instead of `f32`'s NaN-ignoring clamps, keeping the differential test bit-identical; `hit_build`/`hit_query` gained an initialized guard so a call-order mistake returns a status instead of trapping the shared instance; and every `*_init` rejects capacities whose `+8` pad or byte size wraps on wasm32 (silent heap-corrupting allocations in release), with `gw * gh` cell arithmetic moved to i64.

- 064cb65: Fix `\cancel`/`\bcancel`/`\xcancel` emitting a giant filled rectangle and a ~100em advance. The overlay SVG `stretchyEnclose` produces has `width: 100%` and line endpoints `"100%"`; `parseEm` parsed those as `100em`, so the emitter advanced the pen by 100em and drew a ~100em × 100em filled rect over the formula. The emitter now treats a percentage-width SVG as a zero-advance overlay and draws its `LineNode` diagonals as stroked `<line>` elements, with the percent x-endpoints deferred to the enclosing vlist row's width (mirroring the `fullWidth` rule machinery) and the y-endpoints resolved against the box height.
- bea6212: Fix four emitter gaps where CSS-only information was lost between the span tree and the self-contained SVG:

  - Phantom content (`\phantom`, `\vphantom`, `\mathstrut`, …) was drawn as visible ink: the kernel writes `style.color: "transparent"` onto affected nodes, which the emitter never read. It now inherits that state through the tree and skips ink while keeping advances and box metrics.
  - TeX colours (`\color`, `\textcolor`) were dropped and unknown commands were indistinguishable from valid content: placements now resolve their colour from the inherited `style.color` chain (which is also how the kernel's `errorColor` reaches the tree) and consecutive same-colour placements are grouped into nested `<g fill="…">` sections, with the root group keeping the caller's default.
  - Rules from `\underline`, `\overline`, `\hline`/`\hdashline` and `\sout` were silently dropped: any span carrying `borderBottomWidth` (or the `katex-sout` class) now emits a full-width rect resolved against its vlist extent, the same machinery `frac-line` already used.
  - Vlist rows under `op-limits`, `x-arrow`, `mover` and `munder` were flush-left instead of centred, so display-style limits, arrow labels and over/under-braces sat at the operator's left edge rather than under its centre.

## 0.1.0

### Minor Changes

- 1d94445: First published release, at `0.1.0`. `@vectojs/tex` was `private: true` at
  `0.0.0` through Phases 1 and 2 because it was wired to nothing; Phase 3 makes
  `@vectojs/markdown` typeset through it, and a published package cannot depend on
  an unpublished one.

  The version reaches `0.1.0` by applying this `minor` bump to a `0.0.0` manifest,
  which is why the release commit resets the manifest to `0.0.0` first. #381
  hand-edited it to `0.1.0` directly, and `changeset version` always bumps, so a
  `minor` on top of that debuts the package at `0.2.0` and a `patch` at `0.1.1` —
  neither of which is a first release. All four sibling engine packages debuted at
  `0.1.0` (`npm view @vectojs/{text,layout,math,animation} versions`).

  This follows the pattern the four other internal engine packages already
  established — `@vectojs/text`, `@vectojs/layout`, `@vectojs/math` and
  `@vectojs/animation` are all published and consumed by `@vectojs/core` as real
  `dependencies` with caret ranges.

  Two changes beyond the manifest:

  `KATEX_FONT_SCALE` is now exported from the barrel. It is the documented bridge
  between this package's units and a consumer's — the span tree's em is 1.21x the
  consumer's font size, because KaTeX renders at `font-size: 1.21em`
  (`katex.scss:24`) — and a consumer converting emitted geometry to px needs it.
  Verified against real KaTeX in Chromium while wiring the markdown side: four
  display-mode formulas spanning 1.79-2.93 em of height all measured 19.3559 px per
  em at font-size 16, a 0.033% spread, giving 1.20975 against the constant's 1.21.

  `tsconfig.build.json` relaxes `noUnusedLocals`, `noUnusedParameters` and
  `noImplicitReturns`, which were failing the build's exit code with 39 errors
  across 18 files — every one of them inside `src/kernel/`, the KaTeX parse and
  layout kernel that `scripts/vendor-katex.ts` copies from a pinned upstream commit
  and mechanically strips of MathML and DOM emission. Fixing them in place does not
  stay fixed, because the next `bun run vendor` regenerates those files and
  discards the edits; `.oxlintrc.json` already excludes the same directory for the
  same reason, so this applies an existing policy to the compiler. Our own
  `src/emit/`, `src/registry/`, `src/layout.ts` and `src/glyphs/` are clean with
  those flags on, `oxlint` still enforces the two unused-symbol rules across every
  non-vendored file, and real type errors in our code are still caught — verified
  by introducing one.
