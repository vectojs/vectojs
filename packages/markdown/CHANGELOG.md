# @vectojs/markdown

## 0.19.0

### Minor Changes

- 7bdef8e: Make the tail of a long code line reachable

  A fenced code block painted a long line straight through its own rounded
  background and off the viewport edge, where it was hard-clipped. There was no
  wrap and no horizontal scroll, so the tail of the line could not be reached by
  any means — not by selection, not by scrolling, not by resizing. Measured in real
  Chromium: **1016.984px** of a 161-cell line past a 360px box, roughly 3.8x the
  box width.

  `CodeBlock` now owns a horizontal scroll region:

  - `render()` clips its glyphs to the block box, so nothing paints outside the
    background.
  - A new `scrollX` / `maxScrollX` / `setScrollX()` API, clamped to the content.
  - A wheel over the block scrolls it horizontally on **horizontal intent only** —
    a `deltaX` swipe, or `shift`+wheel for a mouse with no horizontal wheel. A plain
    vertical wheel belongs to the page, because a code block is an inline element in
    a scrolling document rather than a scroll container that owns its viewport.
    `ctrl`+wheel is left to browser zoom. `preventDefault` fires only when the
    offset actually changed, so a wheel at either end of travel still scrolls the
    page.

  Overflow-not-wrap is unchanged, and so is the invariant `setWidth()` documents:
  **`height` remains a function of line count alone**, and a width change still
  rebuilds neither the grid nor the highlight. Code that is soft-wrapped instead was
  considered and rejected — it would break that invariant and would re-wrap and
  re-highlight a streamed block on every resize. See
  `forge/decisions/code-block-overflow-2026-08.md`.

  The scroll offset is consumed by the canvas painter and the DOM selection
  carriers through one accessor in the same frame, so a scrolled block's native
  selection stays over the glyphs it covers.

  `CodeBlock` deliberately remains non-interactive: the wheel arrives through the
  content-projection element it already has, so no accessibility node is created
  that would stack above the transparent text mirror and swallow the mousedown that
  starts a drag-selection.

- 9661e56: Add an optional code-block header band showing the fence language, and stop the
  affordance controls overlapping the first line of code

  This fixes a real collision, not only a missing feature. Measured on a 900px
  default-theme `CodeBlock` with `blockAffordances: true`: the first code line
  occupied y 18–42 while both controls sat at y 8–32, so the copy and download
  buttons painted over 14px of the first line of every code block that had them.

  `new CodeBlock(...)` takes a new trailing `CodeBlockOptions` argument, and
  `Markdown` exposes it as `showCodeLanguage`. When enabled, the block reserves a
  band above the code and draws the language at its top-left, which is the space
  the controls were previously drawing into.

  Off by default, for two reasons: the band changes block height, and a document
  in a single language would repeat the same word down its whole length. A fence
  with no info string reserves nothing even when the option is on, since an empty
  band is just wasted space.

  The label is normalized through the same rule the highlighter uses for its
  lookup key, so the two cannot disagree — a block that renders `ts` is a block
  that was highlighted as TypeScript, and ` ```Bash ` or ` ```ts title="a.ts" `
  resolve identically in both.

  Every row-origin site — the painter baseline, the content projection's `y`, and
  the height computation — now reads one `contentTop()` accessor. Applying the
  offset to the painter but not the projection is what detaches a selection
  carrier from the glyphs it is meant to mirror, and a single accessor makes that
  mismatch unrepresentable. Height remains a pure function of line count; the band
  only changes the constant term.

  Two derived theme keys come with it: `codeLangColor`, which follows
  `syntaxCommentColor` when unset because the label has the same "present but
  subordinate" role a comment does, and `codeLangFontSize`, which follows
  `codeFontSize` so raising the code size scales the label with it.

- 9661e56: Carry syntax state across lines, so block comments and multi-line strings
  highlight

  The tokenizer ran independently per line, which is correct only for languages
  whose every construct closes on the line it opens. A JSDoc block was colored on
  its `/**` line and then reverted to plain code for every continuation line, and
  the keywords inside it (`return`, `class`, `function` in prose) were colored as
  live code. CSS was worse: its only comment form is `/* … */`, so the language
  declared no line comment at all and CSS comments were never highlighted.

  `highlightLine()` now takes and returns a carry state, and `CodeBlock` records
  the state entering each line. Block comments (`/* … */`, `<!-- … -->`),
  JS/TS template literals, and Python triple-quoted strings now span lines.

  The carry is deliberately a single open construct rather than a stack, because
  none of these forms nest — a `/*` inside a block comment does not open a second
  one, and treating it as a stack would leave the comment unterminated at the
  first `*/`.

  Single-line quote rules still refuse to carry. That is what keeps a Rust
  lifetime (`&'a str`) from opening a string that would otherwise color the rest
  of the file, and it is why the multi-line string forms are listed separately per
  language instead of being inferred from the quote set.

  The incremental streaming path keeps its prefix reuse: the recorded state is the
  state _entering_ each line, so an appended chunk resumes from the reuse boundary
  by reading one entry rather than rescanning from the top of the block. A
  streamed build and a one-shot build of the same source produce identical
  segments.

- 9661e56: Make the code and table affordance controls selectable and their labels
  translatable

  `blockAffordances: true` was all-or-nothing: it always produced both a copy and
  a download control, always labelled in English. Neither is a reasonable fixed
  choice. Every control is a focus stop in every code block, so a document with
  many fences doubles its tab count for a download nobody asked for, and a
  non-English document had no way to relabel a button a screen reader announces
  verbatim.

  The new `affordances` option takes `copy`, `download`, and a `labels` map.
  Defaults reproduce the previous behaviour exactly, so existing pages are
  unchanged.

  Which controls appear and what they are called are kept as separate axes because
  they are separate decisions — one is interaction and accessibility surface, the
  other is localization, and they are rarely made by the same person. Success
  labels (`copied`, `saved`) are their own strings rather than derived from the
  action labels, since no derivation of "copied" from "copy" survives
  translation.

  `resolveBlockAffordanceConfig()` is exported so a consumer assembling controls
  by hand resolves defaults through the same function rather than restating them
  and drifting.

  Controls are pushed in visual order, which is also DOM and tab order, so the
  keyboard and screen-reader sequence matches what is drawn.

- Raise the `@vectojs/core` peer floor to `>=1.34.0`

  `CodeBlock` now sets `clipToBounds: true` on its content projection, and that
  field only exists in `@vectojs/core@1.34.0`. On an older core the property is
  ignored rather than rejected, so the combination installs cleanly, renders
  without error, and silently loses the fix it was added for — a long code line's
  selection carriers keep painting over whatever sits beside the block. A peer
  range that permits a combination which cannot honour the feature is worse than
  one that refuses it, because the failure surfaces as a rendering complaint
  rather than an install error.

  The horizontal scroll region shipped in `0.18.x` has the same dependency from
  the other direction: without core's content-grid line-origin signature the
  carriers stay frozen while the glyphs move, which was measured at 1017 px of
  divergence. That fix is also in 1.34.0.

  Consistent with how this floor has moved before — `>=1.8.0` to `>=1.24.0` when
  markdown began consuming core's User Timing instrumentation, then to `>=1.25.0`
  — the floor tracks the oldest core that can actually satisfy the package.

- 83a693e: Highlight far more code fences, and stop gating the whole tokenizer on the
  keyword table.

  `highlightLine()` used to return the line as one plain segment whenever the
  language had no keyword set, so an unknown language lost its comments, strings
  and numbers as well — the whole tokenizer sat behind that lookup. The comment
  prefix was hardcoded too (`//` for every language, `#` only for Python and Rust),
  so a shell script's `#` comments were never colored even where the keyword lookup
  succeeded. A shell-heavy document rendered entirely in one color.

  Lexical syntax is now described per language and consulted independently of the
  keyword table, so a language can have keywords, syntax, or only one of the two
  and still be highlighted. Added keyword sets for `bash`, `json`, `css` and
  `html`; lexical syntax for `yaml`, `toml`, `ini`, `dockerfile`, `makefile`,
  `jsonc`, `json5`, `scss`, `sass`, `less`, `glsl`, `c`, `cpp`, `go`, `java`,
  `kotlin` and `swift`; and dialect mapping so `jsx`/`tsx`/`mjs`/`cjs`/`mts`/`cts`
  resolve onto their base language, `sh`/`zsh`/`shell`/`console` onto `bash`, and
  `vue`/`svelte`/`xml`/`svg` onto `html`.

  The fence info string is also normalized now: it was written verbatim, so
  ` ```Bash ` resolved to nothing, and fence attributes (` ```ts title="a.ts" `)
  prevented a match.

  New `highlightedLanguages()` reports what this build can highlight.

  Per-language lexical differences are respected rather than flattened: `//` is not
  a comment in shell or strict JSON, `'` does not open a string in JSON, CSS claims
  no line comment because a line-based tokenizer cannot span its block comments,
  and numbers are left uncolored in markup where they are attribute noise.

## 0.18.2

### Patch Changes

- 3587fe9: Warn when a host wires a layout callback under a name `Markdown` does not have.

  `onLayoutUpdated` is the only layout callback on `Markdown`, and assigning a
  plausible-looking alternative through an `as unknown as` cast compiles, silences
  the type error and then never fires. A property that is only ever assigned has no
  read site to fail, so nothing reports it — found in production, where a blog wired
  its reflow to `onHeightChanged` and every post containing an image stayed laid out
  against the guessed 16:10 aspect ratio with a stale document scroll height.

  The three paths that republish `width`/`height` now go through one notifier, which
  checks for `onHeightChanged`, `onHeightChange`, `onLayoutUpdate` and `onResize`
  when the real hook is unset and warns once per instance. The docstring also now
  names all three trigger paths, including the paragraph-image decode added in
  0.18.1, and states outright that `onHeightChanged` does not exist.

## 0.18.1

### Patch Changes

- e913414: fix(markdown): relayout the blocks below a paragraph image once its bitmap decodes

  A standalone Markdown image was laid out against a guessed 16:10 box before its
  bitmap decoded. `paragraphImage`'s `onLoad` corrected `Image.width`/`height` from
  the real aspect ratio and called `markDirty()`, but nothing re-ran layout — and
  `Stack.layout()` positions children from the size each one reported the last time
  it ran. So every block after the image kept the position computed from the guess,
  and any image taller than the guess (routine: the guess is a flat 0.6 ratio)
  rendered underneath the paragraph that followed it.

  `markDirty()` alone could never fix this. It schedules a repaint of boxes that are
  already wrong.

  **A bare `this.content.layout()` does not fix it either, which is the part worth
  recording.** `Stack.layout()` is not recursive: it reads each child's current
  `width`/`height` and never asks a child to recompute its own box first. Every
  image sits behind at least one intermediate container that caches a height — an
  image-bearing paragraph is itself a `Stack`, and a list-item or blockquote image
  is additionally wrapped in a `MarkdownContainer` — so laying out `content` alone
  re-reads the very boxes the decode just invalidated. Measured on `94d6da3`, a
  600x900 portrait in `![alt](…)\n\nAfter.`: `Image.height` corrects 480 to 900
  while its parent `Stack` stays 480 and the following paragraph stays at `y=496`.

  The fix walks bottom-up from the image's own parent to `content`, so each level
  sees a freshly-sized child before it positions anything — `Stack`s re-run
  `layout()`, `MarkdownContainer` wrappers re-derive their cached box the same way
  `reflowToken`'s `blockquote`/`container` arms and every construction site already
  do. All five image contexts are covered: standalone, list-item lead, list-item
  own-line, blockquote, and an image sharing a paragraph with text.

  Two guards, both with tests:

  - The walk only runs when the decode actually changed the box, so a correctly
    guessed image and the zero-dimension case (which deliberately keeps its guessed
    box) cost no extra layout pass.
  - An image detached before its decode lands — `setContent` or a streamed
    reconcile replacing the subtree mid-flight — is skipped rather than publishing a
    size derived from a tree that is no longer on screen.

  Also fixes a second instance of the same root cause: `listItemBlockStack`'s
  `leadImages` wrapper (an image leading a list item, `- text ![alt](url)`) was the
  one wrapper-image site in the file that never had `width`/`height` assigned at
  all, so the outer `Stack` treated it as a zero-height block from construction,
  before any decode.

## 0.18.0

### Minor Changes

- d2063b2: Stop the `blockMath` tokenizer at a blank line

  **Behaviour change**: a `$$` display-math block now ends at the first blank
  line. Previously its content pattern crossed blank lines, so an unterminated
  `$$` reached arbitrarily far ahead and could absorb the rest of the document
  once a later `$$` arrived.

  **Before**: `$$\nx = 1\n\ny = 2\n$$\n` was one `blockMath` token whose body
  (`x = 1\n\ny = 2`) is not valid TeX.

  **After**: the same source is an unclosed fence (rendered as a `CodeBlock`
  showing the TeX source), then a `y = 2` paragraph, then a `$$` paragraph.

  **Migration**: multi-line math without blank lines is unaffected, which covers
  `aligned`, `cases`, `matrix` and every other multi-line environment:

  ```markdown
  $$
  \begin{aligned}
  a &= b \\
  c &= d
  \end{aligned}
  $$
  ```

  **Scope, stated precisely**: this removes the tokenizer's unbounded forward
  reach, which is a correctness and blast-radius fix. On its own it did **not**
  make math documents lex incrementally, because `incrementalLex` also guarded a
  _backward_ reach through marked's `startBlock` paragraph clip. That remaining
  half is done in
  [`incremental-lex-blockmath-gate`](./incremental-lex-blockmath-gate.md), which
  narrows the gate and carries the streaming measurement; the forward guard here
  was also widened there from `(?!\n\n)` to `(?!\n[ \t]*\n)`, since a
  whitespace-only line is a blank line to marked but was not to this lookahead.

- 9eadff9: Add fenced-block renderer registry for pluggable code fence rendering

  Introduces a new registry system that allows custom renderers to be registered for specific code fence languages (info strings). This enables extending Markdown with new languages (Mermaid, Graphviz, etc.) without modifying the core renderer.

  **New exports:**

  - `registerFencedBlockRenderer(lang, spec)` - Register a lazy-loadable renderer
  - `unregisterFencedBlockRenderer(lang)` - Unregister a renderer
  - `hasFencedBlockRenderer(lang)` - Check if a renderer is registered
  - `isFencedBlockRendererReady(lang)` - Check if a renderer is loaded
  - `ensureFencedBlockRenderer(lang)` - Prefetch a renderer module
  - `renderFencedBlock(source, lang, options)` - Render using the registry
  - `FencedBlockRenderer` type - Renderer function signature
  - `FencedBlockRendererSpec` type - Lazy-loadable renderer specification
  - `FencedBlockRenderOptions` type - Options passed to renderers

  **Changes:**

  - Purely additive: the registry is consulted only for languages the built-in
    `code` and `math` arms do not already claim, so both keep their exact existing
    paths and are deliberately **not** registry entries. Display math depends on
    instance state the registry cannot reach (it subscribes for raster repaint and
    wraps its formula in a `RichText` inline object so selection, find-in-page and
    the a11y projection reach it), and a module-level copy of that logic diverges
    silently.
  - Registry follows the same lazy-load + `incomplete → ready → error` pattern as
    math rendering, prefetching on the opening fence so a streamed block can render
    synchronously once it closes.
  - A renderer is only invoked once its fence is **closed**, the same rule math
    already applies — a half-arrived source is never handed to a renderer as final.
  - Graceful fallback to `CodeBlock` when no renderer is registered, its load has
    not resolved, it failed to load, or it returned `null`.
  - Fully backward compatible — existing code/math blocks are untouched.

  **Example:**

  ```typescript
  import { registerFencedBlockRenderer } from '@vectojs/markdown';

  registerFencedBlockRenderer('mermaid', {
    async load() {
      const mermaid = await import('mermaid');
      return (source, lang, options) => {
        // ... render Mermaid diagram
        return entity;
      };
    },
  });
  ```

### Patch Changes

- abb55ec: Stream math documents incrementally instead of degrading to whole-document lexing

  A line-start `$$` no longer forces `incrementalLex` to re-lex the entire
  accumulated source on every chunk. The `'block-math'` degrade reason is now
  unreachable, so a streamed document containing display math keeps a stable
  block boundary exactly like prose.

  Measured on real headed browsers via `benchmarks/run-browsers.sh`
  (`markdown-stream-math`, Chrome 240.04 Hz / Firefox 239.56 Hz), streaming a
  26 760-char document of 200 heading/prose/formula sections in 32-char chunks
  against an in-process control that re-lexes the whole accumulated source per
  chunk (what a degraded instance does):

  | engine  | before   | after   | speedup    | math/prose ratio |
  | ------- | -------- | ------- | ---------- | ---------------- |
  | Chrome  | 501.6 ms | 3.60 ms | **139.3x** | 0.984            |
  | Firefox | 577.0 ms | 5.98 ms | **96.5x**  | 0.874            |

  The mechanism, from `incrementalLex`'s own counters rather than the clock:
  characters fed to `marked.lexer()` fall **215.9x** (11 222 472 to 51 983), the
  largest single chunk lexes **105** characters at every document size tested
  (25/50/100/200 sections) where the control grows to the full 26 760, and the
  boundary settles at **99.84%** of the document. The `math/prose ratio` column is
  the parity claim: an identical document with formulas replaced by paragraphs of
  comparable length costs the same, so math is no longer a special case. Deep
  token-tree equality against a whole-document lex is asserted before any timing
  is taken.

  This completes the work
  [`blockmath-blank-line`](./blockmath-blank-line.md) started. That changeset
  closed the tokenizer's _forward_ reach; two things remained.

  **The backward reach, narrowed rather than accepted.** marked's `blockTokens`
  clips the text handed to the paragraph tokenizer whenever an extension's
  `startBlock` hook reports a position, and merges the next paragraph into the
  clipped one. `blockMath` supplies `start()`, so a `$$` ahead can re-group
  paragraphs already emitted — which is why the gate degraded outright. Measured
  against marked 18.0.7, the merge additionally requires `tokens.at(-1)?.type ===
'paragraph'`, so it can only rewrite **two adjacent `paragraph` tokens**; any
  token between them, a `space` or a `heading`, blocks it. A stable cut always
  lands immediately after a `space` token, so such a pair can never straddle a
  boundary. The blanket source scan is therefore replaced by a cut ceiling that
  keeps an adjacent pair out of the stable prefix, and the condition is transient:
  once the `$$` arrives and the pair merges, the boundary advances.

  **A hole in the forward guard.** The previous lookahead was `(?!\n\n)`, which is
  not marked's own notion of a blank line (`/^[ \t]*$/` per line). Measured:
  `'$$\nx\n   \n$$\n'` was still ONE `blockMath` token spanning the
  whitespace-only line, while marked pushes a real `space` token for that line —
  so a cut could be placed there and then swallowed when the closing `$$`
  arrived. The guard is now `(?!\n[ \t]*\n)` in both registration sites.

  **Behaviour change, extending `blockmath-blank-line`'s**: a whitespace-only line
  now terminates `$$` just as a bare blank line does. `'$$\nx\n   \n$$\n'` is a
  paragraph run rather than one formula. Multi-line math without blank lines is
  unaffected, so `aligned`, `cases` and `matrix` still work.

  **Also fixed**: `MarkdownWorker.ts` carried the pre-`blockmath-blank-line`
  tokenizer (`[\s\S]+?`, no blank-line guard) while `Markdown.ts` carried the
  guarded one. Both register `blockMath` on the shared `marked` singleton, so the
  effective rule depended on module import order. The two are now identical.

## 0.17.0

### Minor Changes

- Add a broad markdown syntax-coverage cluster:

  - Real subscript (`~x~`) / superscript (`^x^`) via `TextStyle.baselineShift` and new `theme.subscript*`/`superscript*` tokens. Footnote markers are now rendered as true superscript.
  - `++ins++` / `==mark==` via the new `TextStyle.underline`/`highlightColor` fields.
  - `:emoji:` shortcode support via a curated lookup table.
  - Typographic replacements (`--`/`---`, `...`, `(c)`/`(r)`/`(tm)`, curly quotes), gated by `theme.typographer` (default `false`, matching markdown-it's default).
  - `:::` fenced containers (`note`/`tip`/`warning`/`danger`/`caution`).
  - Abbreviations (`*[TERM]: definition`) via a document-wide dictionary, rendered with a dotted underline through the new `TextStyle.abbrTitle` field. Late-arriving definitions trigger a full token rebuild, matching the existing link-definition behavior.
  - Multi-paragraph footnote bodies.
  - Theme presets: `githubDark`, `githubLight`, `dracula`, `solarizedDark`, `solarizedLight`, sourced from each project's canonical palette and resolved through `resolveTheme` so derived tokens still apply.

## 0.16.1

### Patch Changes

- 5c8a9bc: Stop rendering `H~2~O` with a strikethrough through the `2`.

  `marked`'s GFM tokenizer emits a `del` token for a **single**-tilde run as well as
  for the double-tilde strikethrough it is meant for, and `collectSpans`' `del` arm
  applied `lineThrough` to both. So a reader of `H~2~O` saw H2̶O, with no way to tell
  that subscript had been intended.

  This was categorically worse than the constructs this renderer simply does not
  support. Those fall back to visible literal source, which a reader can interpret;
  this one silently changed meaning. A single-tilde run now re-emits its `~`
  delimiters as literal characters and renders its content unstruck, so the source
  round-trips and inner markup still renders — `~*em*~` keeps its emphasis.

  It is **not** subscript. `TextStyle` has no baseline-shift field, so a lowered run
  is not expressible today; this makes the rendering honest rather than complete.

  `~~x~~` is unaffected and keeps striking, including a single-tilde run nested
  inside one (`~~a ~b~ c~~` strikes throughout) — the arm suppresses its own
  striking, not inherited striking. `raw` is what distinguishes the two forms, since
  the token type and `text` are identical.

## 0.16.0

### Minor Changes

- b597ce5: Support GFM footnotes. `[^1]` renders as a small tinted `[1]` marker and `[^1]: note` as its own block, with `theme.footnoteColor` (derived from `linkColor`) and `theme.footnoteMarkerScale` to control them.

  This replaces two wrong renderings rather than filling a gap. Footnote lexing previously split on whether the note body contained a space, because marked's link-reference-definition rule claims the line and a link destination cannot contain one: `[^1]: The note.` rendered the definition as a stray body paragraph and printed `Here[^1] is text.` with its raw syntax, while `[^1]: Note.` turned the reference into a **real clickable link to `Note.`** and dropped the definition from the output entirely.

  Definitions are single-line; a marker prints its label as written rather than renumbering, so a reference renders before its definition arrives while streaming. Claiming the definition line ahead of marked's `def` rule also keeps `tokens.links` empty, so a footnoted document no longer permanently degrades incremental lexing.

## 0.15.0

### Minor Changes

- 4c83ccb: Render images in headings and table cells, which previously vanished.

  There was no `case 'image'` in the inline switch, so `Tokens.Image` fell to
  `default:`, which pushes `.text` — the **alt text rendered as ordinary prose** and
  the picture was gone. Nothing threw and nothing was blank, so `# Title ![logo](u)`
  simply read as "Title logo". Images in paragraphs, blockquotes and list items were
  unaffected; they render through paragraph splitting, so this was 2 of 4 contexts.

  An image sharing a line with text now renders as an inline box, reusing the same
  mechanism inline math uses, which keeps selection and the accessible name. Its
  height is `theme.inlineImageScale` (new, default `1.15`) times the run's font size
  and its width follows the natural aspect ratio, so a badge stays wide. A failed
  load degrades to the alt text rather than leaving an invisible gap.

  Also fixed: `containsImage` walked only `.tokens`, so it returned false for an
  image inside a `table` (whose cells live in `header`/`rows`) or a `list` (whose
  items live in `items`). A table-cell image therefore never learned its own aspect
  ratio and kept the square box it had reserved before decoding.

  Two behaviours that were previously undocumented and untested are now both pinned
  and described in the README: a definition list renders as its two literal lines,
  and a non-SVG raw HTML block renders nothing. Backslash escapes are pinned too —
  they worked only because `Tokens.Escape.text` is already unescaped and the
  `default:` arm happened to push it.

- 1d94445: Typeset math through `@vectojs/tex` instead of `mathjax-full`, completing Phase 3
  of the in-house TeX engine. The `mathjax-full` dependency is removed.

  **The math path is 4.06x smaller.** Measured with one bundler invocation
  (`bun build --splitting --minify --target=browser`) against a consumer that
  imports `Markdown`, before and after, so the delta is attributable to the swap:
  the whole bundle goes from 19 chunks / 2 199 869 raw / 748 713 gzip to 3 chunks /
  758 249 raw / 273 754 gzip — **63.4% smaller**. Isolating the math path against a
  no-math floor (the same consumer with every engine import stubbed, 118 670 gzip)
  gives 630 043 gzip for MathJax versus 155 033 for `@vectojs/tex`. A prose-only
  consumer's eagerly-downloaded entry chunk is unchanged (118 320 → 117 889 gzip).

  No public API change. `MathBlock`, `preloadMathJax` and `isMathJaxReady` keep
  their names and behaviour, and `MathRender` stays module-private. The `MathJax` in
  those two names is now historical — they mean "the math engine" — kept because
  `test/publicApi.test.ts` pins them and renaming would break every consumer for
  cosmetics.

  The lazy dynamic import stays, though the new engine is fully synchronous.
  Bundle size is what motivates it, not engine synchrony: the engine is 84% of the
  bundle above, and `renderMathToSVGDataURI` is reachable from the render arm, so a
  static import cannot be tree-shaken and a prose-only consumer would pay the whole
  engine to render a paragraph. The first formula on a page therefore still renders
  as TeX source until the module resolves, and `preloadMathJax()` is still the way
  to avoid that.

  What the swap removed: six dynamic imports of `mathjax-full`'s CommonJS entry
  points, the `interop` helper they needed (esbuild wraps a CJS module and emits
  only `export default require_x()`, a defect that typechecked and passed every
  unit test before failing in a real browser bundle), and
  `convertMathToSVGDataURI`'s regex-scraping of `width="..ex"` and
  `vertical-align:-N ex` back out of MathJax's serialized SVG. Geometry now comes
  from the layout tree as numbers.

  Colour handling changed mechanism but not behaviour. MathJax painted glyphs with
  `fill="currentColor"` and needed a `style="color:…"` injected on the root, because
  a `data:` URI is an isolated document where `currentColor` falls back to black —
  invisible against this package's own dark default theme. `@vectojs/tex` takes a
  `color` option and writes it directly, so there is no `currentColor` left to
  resolve. Colour remains part of the cache key.

  A formula containing a glyph outside the shipped corpus degrades to TeX source in
  a `CodeBlock`, the same state an unclosed fence uses. Rendering anyway would show
  a formula with a symbol silently absent, which reads as a different equation.

  Adds `test/mathBoxGeometry.test.ts` (11 tests), which pins the px box a formula
  reserves. Nothing previously read that box — `widthEx`, `heightEx`, `depthEx` and
  `exToPx` appeared in no test — so the entire suite passed while the box was
  sabotaged five different ways, including a uniform 21% mis-size of every formula.
  All five sabotages now fail.

- 2c569a8: Centralize Markdown theme tokens: hoist every hardcoded color, font size and
  spacing value into `MarkdownTheme`.

  `MarkdownTheme` gains 18 keys covering the values that were previously literals
  at their use sites: `linkColor` (which had five separate copies),
  `mathFallbackColor`, the four `syntax*Color` keys (previously function-local
  constants inside the highlighter, unreachable from outside), `headingSizes`,
  `codeFontSize`, `tableFontSize`, `codeLineHeight`, `bodyLineHeight`, and the
  spacing set `blockGap`, `codePadding`, `codeRadius`, `listGap`, `listItemGap`,
  `quoteIndent`, `quoteInnerGap`, `quoteBorderWidth`, `imageRadius`.

  Two keys are derived rather than fixed, so overriding one value no longer
  silently desynchronizes another:

  - `tableFontSize` defaults to `fontSize - 2`, so raising only `fontSize` still
    scales tables.
  - `quoteTextColor` defaults to `textColor`. It was declared and defaulted but
    **never read** — blockquote text was not themeable at all despite the key
    existing. It is now applied.

  `CodeBlock`'s constructor accepts a partial `MarkdownTheme` and resolves it
  against the defaults. It previously required a fully-populated theme, so a
  caller passing a hand-built literal written against the old 12-key shape would
  throw `lineHeight must be a positive finite number` once size keys became
  theme-driven. No existing caller needs to change.

### Patch Changes

- cc662fe: Split `Markdown.ts` into six domain modules — `theme`, `markdown-entities`,
  `markdown-image`, `markdown-code`, `markdown-math` and `markdown-inline` —
  taking the file from 5172 to 3315 lines ahead of the queued syntax work
  (footnotes, the image arm, a fenced-block renderer registry), each of which adds
  arms to switches inside it.

  No public API change: every symbol previously exported from `Markdown.ts` is
  re-exported from it, and a new `test/publicApi.test.ts` pins that surface,
  including binding identity across the re-export so `instanceof` keeps working.
  `MathRender` stays module-private as before.

  Two module-level bindings that would otherwise have to be exported across a file
  boundary are now encapsulated instead. The three `mathConverter` reads in the
  component were pure null-checks and now call the `isMathJaxReady()` that already
  returned exactly that, and `inlineMathRasterWaiters` gained subscribe/unsubscribe
  functions so the `Set` stays private to the math module.

  `mathjax-full` is now referenced from exactly one file, which is what Phase 3 of
  the in-house TeX engine has to replace.

- Updated dependencies [1d94445]
  - @vectojs/tex@0.1.0

## 0.14.0

### Minor Changes

- 1b105d7: Add opt-in copy / download controls to code blocks and tables

  A reader could see a code block or a table but not take it away. `blockAffordances: true` now draws a copy and a download control in the top-right corner of every fenced code block and every table.

  The controls are `@vectojs/ui` `Button`s rather than a bespoke a11y hotspot. `Button` already projects `tag: 'button'` with an accessible name, drives its focus ring from real DOM focus/blur, and handles hover and the disabled state; a hand-rolled hotspot would have had to re-earn all of it. Verified in real Chromium **and** real Firefox: four controls project as real `<button>` elements, a pointer click and a focused `Enter` each deliver the payload, and the accessible name changes to a confirmation and reverts. Firefox's clipboard permission model differs from Chrome's, so both engines were a requirement rather than a nicety.

  A wrapper entity owns the corner placement because both candidate parents already own their children's geometry — `Stack` positions each child in flow and `Table` recomputes `x`/`y`/`width`/`height` from its column widths — so a control added directly to either would be moved on the next layout.

  Serialization follows `streamdown`, including two details that are commonly omitted and each a real defect when missing: the object URL is revoked after the download click, and CSV carries a UTF-8 BOM so Excel on Windows does not read the file in the system ANSI codepage and corrupt every non-ASCII cell. The BOM is emitted by `tableToCsv` rather than by the file-saving primitive, so it survives a caller supplying its own `saveFile` — a property of the CSV belongs to the CSV.

  A table copies as Markdown and downloads as CSV: the reader took it out of a Markdown document, so another Markdown document is the likely destination for a paste, while a spreadsheet is what a file is for. Column alignment is reproduced from the token, so a copied table re-lexes to the alignment it had.

  Off by default. It adds two focusable stops per block, which a document with many fences would make tedious to tab past, and a reader who cannot act on a control is better served by not being offered one.

### Patch Changes

- 384597b: Render images nested inside links, emphasis and list items

  `paragraphHasImage` and the paragraph render arm both tested
  `token.tokens?.some((c) => c.type === 'image')` — **direct children only** —
  while `marked` nests an image as deeply as the source does:

  | source           | token shape                               |
  | ---------------- | ----------------------------------------- |
  | `![a](u)`        | `paragraph > image`                       |
  | `[![a](u)](d)`   | `paragraph > link > image`                |
  | `- item ![a](u)` | `list > list_item > text > [text, image]` |

  Any nesting therefore failed the predicate, fell through to `inlineRunRichText`,
  which has no image support, and the image vanished with no warning. This is the
  same shape of defect as the list-item block children fixed earlier: a predicate
  over direct children gating a construct that legitimately nests.

  The predicate now recurses over descendants, and the render arm flattens nested
  images to the top of the inline run before splitting it, so an image inside a
  link, inside emphasis, or several levels down all reach `paragraphImage`. A
  wrapper that also held text is replaced by its children rather than dropped, so
  the prose around the image survives; a wrapper with no image keeps its own token
  and therefore its styling and click handling.

  A list item needs one more step, because its lead run carries the marker and is
  one `RichText`. The lead keeps its prose with images stripped out, and those
  images render as blocks beneath it. Excluding the whole child from the lead
  instead does not work: an empty lead makes `listItemSpans` fall back to the
  item's **raw** `text`, which rendered `- item ![a](u)` as literal Markdown source
  above the correctly-split block.

  Reference-style `![alt][id]` was reported as a third failing form. It is not: the
  token is `paragraph > image` with `href` resolved, byte-identical in shape to a
  working plain image, and it renders both one-shot and streamed. A regression test
  records that so it is not re-investigated.

## 0.13.0

### Minor Changes

- b92985a: Render display math as selectable text instead of an `<img>`

  `renderDisplayMath()` built `new Image(svgDataUri, { alt: formula })`. An `Image`
  reports `getA11yAttributes(): { tag: 'img', src, alt }` and has no
  `getContentProjection()`, so a `$$…$$` block contributed nothing to the projected
  text layer — not to `innerText`, not to find-in-page, not to a selection, not to a
  copy. Inline `$…$` in the very same document did, because it reserves a
  `StyledSpan.object` and `RichText` substitutes each object's `alt` for the U+FFFC
  sentinel when it projects. A reader with both in one document found one selectable
  and the other not.

  A display formula is now one inline object in a one-span `RichText`, the same seam
  inline math already used, so the TeX source reaches selection, find-in-page, copy
  and assistive technology through the existing projection path rather than a second
  mechanism. Verified in real Chrome on a 60-line document: zero math `<img>`
  elements where there were previously one per visible formula, and
  `window.find('\\cos\\theta')` — a display formula — now matches where it could not
  before.

  Removing the `<img>` also removes the `draggable="true"` that let a formula be
  dragged out of the document as an SVG _file_ and dropped back into an app's own
  file handler. No reference implementation needs a `draggable="false"` workaround,
  because none generates an image; this deletes the vector rather than suppressing
  it.

  Formulas are now wrapped in an exported `MathBlock` entity carrying the TeX source
  and the typeset SVG URI, which is what keeps them addressable for devtools and
  tests once the `Image` is gone.

## 0.12.0

### Minor Changes

- 71644c4: Render block-level children of list items instead of flattening them to text

  A list item was built as a single inline `RichText`, so any block-level child —
  a `$$…$$` display formula, a fenced code block, a table, a blockquote, an `hr`,
  a nested list, or a second paragraph — fell through to its raw source and was
  painted as literal characters. Parsing was never at fault: marked does emit a
  `blockMath` token as a sibling of the item's inline content; the renderer had no
  branch for it.

  Measured on a real 60-line document, 9 of its 10 display formulas were affected:
  the one at indent 0 rendered, and every one at indent 2 inside a list item did
  not. The discriminator was list membership, not the formula.

  An item holding a block now becomes a vertical `Stack` — its lead inline run
  carrying the marker, then each remaining child rendered through the same
  `renderToken` the document level uses, indented to clear the marker. Nested
  lists, which previously vanished entirely, now render.

  Inline-only items keep the single-`RichText` fast path, which is what
  `updateStreamedList` reuses via `setSpans`; the streamed path is tiered the same
  way and promotes an item off the fast path when its `$$` or fence closes
  mid-stream.

## 0.11.0

### Minor Changes

- d011cc8: Add dirty-tracked content projection sync.

  `Scene` re-derived every resident block's DOM text projection on every synced
  frame, even when nothing had changed. Measured on a 1500-resident-block document
  in real headed Chrome, a sync whose projected text was byte-identical before and
  after still cost 17.875 ms, because `getContentProjection()` — an O(glyphs) build
  — ran once per block and its result was re-diffed against the DOM.

  `Entity.getContentEpoch()` is new, optional API: return a number that changes
  whenever the entity's projected content changes, and `Scene` will skip the block
  entirely — before the projection call — while both that epoch and the entity's
  geometry are unchanged. The default returns `null`, which keeps the previous
  behaviour exactly, so this is opt-in and no existing subclass is affected.

  `Text`, `RichText`, `CodeBlock`, `TextEntity` and `MSDFTextEntity` now implement
  it, so text-heavy and streaming scenes get the reduction without any code change.
  Only the blocks that actually changed are re-projected; a streaming tail block
  costs one rebuild instead of one per resident block.

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
