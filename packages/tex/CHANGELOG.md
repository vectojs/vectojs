# @vectojs/tex

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
