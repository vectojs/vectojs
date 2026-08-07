# @vectojs/tex

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
