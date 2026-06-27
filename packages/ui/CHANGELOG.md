# @vecto-ui/ui

## 0.3.2

### Patch Changes

- feat(a11y): strengthen a11yRoot with strict DFS DOM ordering, typing synchronization protection, and full WAI-ARIA keyboard navigation for Dropdown.
- Updated dependencies
- Updated dependencies [cd3e3e8]
  - @vecto-ui/core@0.7.1

## 0.3.1

### Patch Changes

- Updated dependencies [3dfbfd4]
  - @vecto-ui/core@0.7.0

## 0.3.0

### Minor Changes

- a964f1c: feat(ui): add Flow layout component and Stack wrap support

  - `Stack` now accepts `wrap`, `maxWidth`, and `maxHeight` options. When
    `wrap: true`, children overflow onto the next line when the main-axis
    extent exceeds the limit — producing a CSS flexbox-like flow layout.
    Existing non-wrapping Stacks are unaffected (backward compatible).
  - Added `Flow` convenience component: a `Stack` pre-configured with
    `direction: 'horizontal'` and `wrap: true` — the most common use case
    for responsive tag/chip/card layouts.

- aa5e473: Streaming Markdown plus a wider component suite.

  - **`Markdown`**: a canvas Markdown renderer with `setContent()` and `appendMarkdown()` for streaming/LLM output — unchanged prefix paragraphs are reused and a growing paragraph is appended in place, activating the `LayoutEngine` paragraph memo so live output doesn't re-render the whole document. Inline tokens (bold/italic/code/links, with a11y projection) map to `RichText`; a highlighted code block collapses to a single `CodeBlock` leaf entity instead of N×M child entities.
  - New components: `Table`, `Dropdown`, `Slider`, `Modal`.

### Patch Changes

- 382e34f: Text flow around exclusion rects (战役一, PR B — "文字绕流" v1): text can now wrap around rectangular regions, like CSS floats.

  - **`@vecto-ui/core`**: new pure `computeLineSegments(top, bottom, maxWidth, exclusions)` returns the free horizontal segments left on a line after subtracting the `ExclusionRect`s that overlap its band (left/right floats narrow the line; a centered rect splits it in two; a full-width one skips the band). `LayoutEngine.layoutPrepared` takes an optional third `exclusions` argument and flows words across those per-line segments. New exports: `ExclusionRect`, `LineSegment`, `computeLineSegments`. The single-column path (no exclusions) is byte-for-byte unchanged.
  - **`@vecto-ui/ui`**: `RichText` gains an `exclusions` option and a `setExclusions()` method.

- b5e2c76: Inline rich-text flow (战役一, PR A): bold / italic / colored / differently-sized runs that flow and wrap on the same lines, sharing a baseline.

  - **`@vecto-ui/core`**: new `LayoutEngine.prepareRich(spans, atlas, baseFontSize, baseStyle?)` cold pass taking `StyledSpan[]`. Each grapheme carries the (base-merged) `TextStyle` of the span it came from — so a style change _mid-word_ is honored — and is measured at its run's `fontSize`. `layoutPrepared` now baseline-aligns mixed sizes (tallest run on a line drives line height; smaller glyphs drop to the shared baseline) and carries `style` onto each `LayoutNode`. New exports: `TextStyle`, `StyledSpan`; `PreparedGlyph`/`LayoutNode` gain an optional `style`. Plain (single-style) layout is unchanged.
  - **`@vecto-ui/ui`**: new `RichText` component — renders styled runs via the engine's rich path, drawing each glyph with its run's color and weight/slant.

- 90a4339: Inline links in rich text (战役一, PR A.5): a `{ href }` run in a `RichText` is underlined and painted in the link color on the canvas, and projects a real, operable `<a href>` shadow node so screen readers announce it and automation agents (Playwright / AI) can find it by href and click it — routing back to `onLinkClick`.

  - **`@vecto-ui/core`**: new public `Scene.detachA11y(entity)` to prune the shadow node(s) of an entity subtree on demand. Interactive _child_ entities (e.g. per-link hotspots) call this when they are removed, so the per-frame `syncA11y` (which only creates/updates) never leaks stale nodes.
  - **`@vecto-ui/ui`**: `RichText` gains `linkColor` and `onLinkClick` options. Each contiguous `href` run gets one transparent `<a>` hotspot child, kept stable across re-wrap (one per run) and pruned when the links change. Link glyphs render with the link color plus an underline.

- cd28e58: Streaming / typewriter rich text (战役一, PR C — "流式打字机"): re-laying out a growing styled document is now O(changed paragraph) instead of O(document).

  - **`@vecto-ui/core`**: `LayoutEngine.prepareRich` now memoizes per paragraph (mirroring the plain `prepare` memo), keyed by `fontSize` + text + a _value_-based run-length signature of the inline styles. A streaming caller that appends styled runs reuses every untouched leading paragraph by reference — even if it passes fresh style objects with the same values. The memo is invalidated when the font atlas changes.
  - **`@vecto-ui/ui`**: `RichText.appendSpans(spans)` and `Text.append(text)` for incremental streaming; both re-lay out through the paragraph memo.

- 7a702a8: Add a multi-line `TextArea` component (战役二).

  - **`@vecto-ui/ui`**: new `TextArea` — a multi-line field backed by a real, transparent `<textarea>` shadow node. The browser owns editing (keyboard, IME composition, selection, clipboard, undo, multi-line navigation); the canvas mirrors it, re-wrapping the value and drawing text, cross-line selection, and a blinking caret with vertical scroll-to-caret. Exposes a pure `wrapText(value, maxWidth, measure)` helper (offset-aware line wrapping with hard-newline + char-level breaking) and `lineOfOffset()` for caret mapping.
  - **`@vecto-ui/core`**: the a11y/automation shadow layer now supports `tag: 'textarea'` — `Scene.syncA11y` projects a `<textarea>`, sets its placeholder, syncs its value, and forwards its `input`/`change`/selection/IME events back to the entity (previously only `<input>` was wired).

- c1aebf2: Add touch / pointer-drag support.

  - `core`: `Scene` calls `setPointerCapture` on `pointerdown` and releases it on `pointerup`, so a drag keeps receiving `pointermove`/`pointerup` after the pointer leaves the node's box; interactive shadow nodes get `touch-action: none` so the browser doesn't claim touch drags (the canvas owns its gestures).
  - `ui`: `ScrollView` now scrolls by pointer-drag (touch & mouse), not just the wheel — content follows the finger 1:1 and clamps to the content bounds. The wheel/drag clamping is shared in one helper.

- Updated dependencies [c98d3e3]
- Updated dependencies [8faa813]
- Updated dependencies [668e503]
- Updated dependencies [382e34f]
- Updated dependencies [b5e2c76]
- Updated dependencies [90a4339]
- Updated dependencies [aa5e473]
- Updated dependencies [2a20b15]
- Updated dependencies [2512008]
- Updated dependencies [6ad07c7]
- Updated dependencies [cd28e58]
- Updated dependencies [7a702a8]
- Updated dependencies [c1aebf2]
  - @vecto-ui/core@0.6.0

## 0.2.3

### Patch Changes

- 9253e61: Memoize `measureText` with a bounded LRU cache (`(font, text) → width`).

  Native canvas `measureText` forces a layout/context switch on every call. Hot paths re-measure the same strings each frame — `wrapLines` (per-word candidates) and `Input` caret positioning (growing prefixes) — so a 1000-entry LRU keeps the working set hot while capping memory for dynamic text. Behavior is unchanged; repeated measurements are just served from cache.

- c1d428f: Add a scrollable viewport (`ScrollView`) with clipping + wheel scrolling.

  - `core`: `Entity.clipChildren` (Scene clips a node's children to its local box) and a forwarded `'wheel'` event from the shadow node (non-passive, so a scroll container can `preventDefault()` the page scroll).
  - `ui`: `ScrollView({ width, height })` — nests children in a clipped content layer, scrolls on wheel with a damped spring, and clamps to the content bounds. Unblocks scrollable docs/long-list pages built with VectoUI.

- 6f84f7f: `Toggle` now emits a `change` event, unifying the form-control event model.

  Previously a `Toggle` only invoked its `onChange` constructor callback, so
  external `on('change', …)` listeners never fired (its `role="switch"` shadow node
  is a `div`, which the Scene doesn't forward native changes for — unlike `Input`
  /`Checkbox`). Toggling now goes through a single `change` handler that drives both
  `on('change')` and `onChange`, matching the other form components.

- Updated dependencies [ac8b159]
- Updated dependencies [59a2b64]
- Updated dependencies [c1d428f]
- Updated dependencies [7f5e403]
- Updated dependencies [9d587db]
  - @vecto-ui/core@0.5.3

## 0.2.2

### Patch Changes

- 7c9e40c: Docs: rewrite READMEs for accurate positioning and honest, reproducible numbers.

  Removes the fabricated "React vs core" comparison table (1k/10k/100k → React
  "Crash" vs "60 FPS") and the misleading "60 FPS with 100,000+ entities" tagline.
  READMEs now describe VectoUI as a Zero-DOM canvas UI runtime with the a11y/agent
  moat, cite measured benchmark numbers, list the full component set, document the
  IME-capable `Input`, and state where the framework does and doesn't fit.

- 88c08c5: Route `Text` through the shared `LayoutEngine` instead of its own ad-hoc
  `wrapLines`. `Text` now uses the same `Intl.Segmenter` measurement path as
  `TextEntity`, with the cold/hot split: `setText` re-measures (cold), the new
  `setMaxWidth` re-wraps via the hot path only (no re-segmentation/re-measurement).
  Blank lines and explicit newlines are preserved. Public `measureText` /
  `wrapLines` / `fontSizePx` are unchanged and still exported.
- Updated dependencies [715693b]
- Updated dependencies [7c9e40c]
  - @vecto-ui/core@0.5.2

## 0.2.1

### Patch Changes

- 0362f14: IME / text-selection moat for the canvas `Input` (canvas-mirror approach).

  The real, transparent `<input>` shadow node already handles all native input
  (IME composition, selection, clipboard, undo); the canvas now mirrors it visually.

  - **core**: `IRenderer.clip(x, y, w, h)` (rect clip, implemented in `CanvasRenderer`).
    `Scene.syncA11y` forwards IME composition (`{ start, length } | null`), selection
    (`selectionStart`/`selectionEnd`), and new `focus`/`blur` events from text `<input>`
    shadow nodes; the `change` payload is extended accordingly.
  - **ui**: `Input` renders a blinking caret (when focused), a selection highlight, the
    IME composing segment (underlined), and scrolls horizontally to keep the caret in
    view for overflowing text. A human can now type CJK into a pure-canvas field; agents
    still drive it by role.

- Updated dependencies [1de96df]
- Updated dependencies [0362f14]
  - @vecto-ui/core@0.5.1

## 0.2.0

### Minor Changes

- 9abb2b5: Add six new component primitives, completing the layout/display and form-control set.

  - **Layout/display**: `Image` (`<img alt>` shadow node, placeholder until load),
    `Card` (rounded panel + optional border, optional `role="group"`), `Stack`
    (vertical/horizontal auto-layout with gap + cross-axis align).
  - **Form controls** (real shadow nodes, agent-/AT-operable by role): `Input`
    (`<input>` textbox, value flows back via the `change` event), `Checkbox`
    (`<input type=checkbox>`), `Toggle` (`role="switch"` with `aria-checked`).
  - Exposes `fontSizePx(font)` and fixes a sizing bug: component height now parses
    the `px` token from a CSS font shorthand instead of `parseFloat`, which wrongly
    returned the _weight_ for fonts like `'600 16px sans-serif'` (made buttons/links
    hundreds of px tall).

### Patch Changes

- Updated dependencies [9abb2b5]
  - @vecto-ui/core@0.5.0

## 0.1.4

### Patch Changes

- Updated dependencies [a888e97]
- Updated dependencies [f68ade4]
  - @vecto-ui/core@0.4.0

## 0.1.3

### Patch Changes

- Updated dependencies [42819e7]
- Updated dependencies [3eb0910]
  - @vecto-ui/core@0.3.0

## 0.1.2

### Patch Changes

- 6fe2997: Fix the published dependency on `@vecto-ui/core`.

  Previous releases (0.1.0, 0.1.1) shipped with `"@vecto-ui/core": "workspace:*"`
  in the published `package.json` — the workspace protocol was not rewritten at
  publish time, so `npm install @vecto-ui/ui` failed with `EUNSUPPORTEDPROTOCOL`.
  The dependency is now a real semver range (`^0.2.0`), which bun still links
  locally in the monorepo and changesets keeps in sync on future core releases.

## 0.1.1

### Patch Changes

- Updated dependencies [cd59328]
- Updated dependencies [cd59328]
- Updated dependencies [6463b61]
  - @vecto-ui/core@0.2.0

## 0.1.0

### Minor Changes

- e3b05d3: Add `@vecto-ui/ui` — high-level canvas UI components rendered to a `<canvas>`
  with an accessibility/automation shadow layer:

  - `Text` — multi-line text via native canvas measurement, projects a labelled
    `div`.
  - `Button` — rounded-rect button with hover state, projects a real
    `<button role="button" aria-label>`; `onClick` fires from both the canvas
    hit-test and the shadow button.
  - `Link` — underlined link text, projects a real `<a href>` (natively clickable
    and crawlable).

  Built on the new `Entity.getA11yAttributes()` hook so screen readers and
  automation agents can operate the canvas UI.
