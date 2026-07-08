# @vectojs/ui

## 1.0.0

### Major Changes

- First stable release. All core engine features (scene graph, layout, hit-testing, animation drivers, WebGL/WebGPU/Canvas2D/SVG rendering, accessibility projection, text shaping/bidi) and the full UI component set have shipped and been through a complete file-by-file audit of both packages, with a live-interaction QA pass across every demo and renderer backend. No known bugs or vulnerabilities remain open.

  This is a semver commitment: breaking changes to the public API of either package now require a major version bump.

## 0.2.8

### Patch Changes

- 01c8abc: Fix `Markdown`'s blockquote rendering: the left accent border and the quote text were meant to overlay at the same position, but were built inside a `Stack`, whose `add()` re-runs sequential auto-layout on every call — silently moving the text below the border instead of overlaying it, while the container still reported a height that didn't cover the (mis)placed text. The overlay container is now a plain, non-layouting entity, so the border and text render together as intended.
- da1c45c: Fix `ContextMenu` showing the wrong submenu content: the submenu instance was lazily created once and reused for every item with `children`, tracked by a single `_submenu` field with no record of _which_ item it represented. Opening a second submenu item just repositioned the first item's still-showing submenu instead of building one for the newly-clicked item. The submenu is now rebuilt whenever a different item is opened.
- 33a3939: `Input` no longer re-scans the entire value for RTL-script characters on every `charOffset()` call. The scan ran uncached, and a single render (or caret blink) tick could call `charOffset()` several times (caret position, selection start, selection end, composition bounds) plus once more inline in the selection-highlight branch — each redoing the same O(n) scan from scratch. It's now cached alongside the existing layout cache, invalidated only when `value` changes.
- 0cca389: Fix `Tooltip` and `Popover` leaking a listener on their target entity: both registered a `hover`/`click` closure directly on the caller-supplied `target` without ever removing it, so destroying a `Tooltip`/`Popover` while its target stayed alive left the target holding a reference to the dead instance — a later hover/click would resurrect the destroyed overlay back into the scene tree instead of being a no-op. Both now store the handler and detach it in `destroy()`.
- 3de7bcc: Fix `TreeView`'s lazy-load spinner disappearing prematurely: the `loading` flag was mutated directly on the `FlatRow` object captured before the `await`, but a sibling lazy node resolving in the meantime calls `_buildRows()`, which replaces `this._rows` with entirely fresh row objects (always defaulting `loading: false`). The original row's later `loading = false` then mutated a detached, no-longer-rendered object — leaving the still-pending node's row showing no spinner and no children until its own load finished. `loading` is now tracked in a `Set<string>` on the TreeView itself and read by `_buildRows()`, so it survives rebuilds triggered by other in-flight loads.

## 0.2.7

### Patch Changes

- a2d7d3b: Text and RichText mirror their rendered text into the DOM content layer (core 0.2.7 content projection) — Markdown bodies become findable, screen-reader-visible, and translatable automatically since Markdown composes these components.

## 0.2.6

### Patch Changes

- f4c98f3: Slider now supports Arrow/Home/End keyboard input (making its slider role honest) and a configurable step for both pointer and keyboard, snapped on a min-anchored grid.
- e45ec38: - `VirtualList` and `TreeView` scroll animations are now visible to the Scene's idle throttle / onDemand skip via `hasPendingAnimations()` — smooth scrolling no longer steps at 2 FPS (or stalls in onDemand mode) once the throttle engages. Same regression class as the earlier ScrollView fix.
  - `Tooltip` restarts (instead of stacking) its show-delay timer on repeated hover, and cancels it on `destroy()`.

## 0.2.5

### Patch Changes

- Fix form-control redraws in on-demand scenes, stabilize CodeBlock spacing, and keep resizable panel sizes bounded after resize.

## 0.2.4

### Patch Changes

- Forward `MarkdownOptions.onLinkClick` through paragraph, heading, and list `RichText`
  renderers, and make `Markdown.renderToken()` protected so custom Markdown renderers can
  subclass safely without patching internals.
- Mark interactive state changes dirty in `Button`, `Slider`, `Checkbox`, and `Toggle` so
  `onDemand` scenes repaint immediately during hover, drag, checkbox, and switch updates.

## 0.2.3

### Patch Changes

- Use the shared affine local-coordinate contract for interactive controls, position overlays from
  transformed world bounds, reject executable link schemes, and align accessibility behavior across
  the component library.

## 0.2.2

### Patch Changes

- 6335e42: Fix `ScrollView.scrollToBottom()` retargeting the scroll spring on every call instead of snapping instantly. Callers that track growing content (e.g. a streaming chat auto-following new tokens) call this many times a second, which never let the spring settle — the viewport visibly jittered instead of tracking the newest content. Wheel/drag scrolling is unaffected and still springs.

## 0.2.1

### Patch Changes

- 40182bd: Fix choppy/stepped motion for any in-flight `setTransition`/`animateTo`/`springTo` animation in the default `always` render mode: `Entity.hasPendingAnimations()` didn't check active property drivers, so once Scene's idle auto-throttle engaged, an animation only advanced one frame per external `markDirty()` call instead of every render frame (a `markDirty()` called from inside `update()` is wiped by the loop's own `dirty = false` at the end of that same tick — only `hasPendingAnimations()` reliably holds the throttle off across frames).

  `ScrollView` is refactored to drive its content's scroll offset through this shared, dt-aware spring system instead of a hand-rolled, frame-rate-dependent integrator, fixing both the throttle-invisibility and the dt-independence in one pass. This is most visible in the AI Chat demo, where scrolling now glides continuously alongside token-by-token streaming instead of stepping in bursts synchronized to token arrival.

## 0.2.0

### Minor Changes

- 21cea39: Add a unified, spring-first animation system.

  `@vectojs/core` gains an easing library (`Easing`), per-property spring/tween
  drivers, and a declarative + imperative API on `Entity`: `setTransition` (assign
  a configured property and it animates), plus `animateTo` / `springTo` (imperative,
  Promise-returning). The six transform/visual properties (`x`, `y`, `scaleX`,
  `scaleY`, `rotation`, `opacity`) are now accessors with a zero-overhead fast path
  when no transition is configured (benchmarked: 5000 writes/frame ≈ 89µs, 0.5% of a
  60fps budget). Legacy `Entity.animate()` is preserved. Adds an `onMounted`
  lifecycle hook and honors `prefers-reduced-motion` (movement snaps, opacity fades).

  `@vectojs/ui` gains a shared enter/exit presence helper on `UIComponent`
  (`enterMotion` / `exitMotion` / `dismiss`). `Modal` and the `Overlay` family
  (`Tooltip` / `Popover` / `ContextMenu`) now animate through the shared system,
  replacing their bespoke `SpringPhysics` and hand-rolled lerps.

- c889611: Add Overlay (shared positioning engine), VirtualList (virtual scrolling with fixed and variable heights), TreeView (eager and lazy child loading), ResizablePanel (PanelGroup, Panel, PanelResizeHandle for N-panel nested resizable splits), Tooltip (hover trigger), Popover (click trigger), ContextMenu (right-click, separators, nested submenus), RadioGroup (horizontal/vertical option groups), Tabs (tabbed panel container), and ProgressBar (filled indicator bar with text display option) components.

## 0.1.1

### Minor Changes

- c8896118: Added ten new native UI components: `Overlay`, `VirtualList`, `TreeView`,
  `ResizablePanel`, `Tooltip`, `Popover`, `ContextMenu`, `RadioGroup`, `Tabs`, and
  `ProgressBar`.

### Patch Changes

- c8896118: Aligned `Toggle`, `Checkbox`, `Input`, `Dropdown`, and `Slider` so their change
  callbacks fire through the same consistent shape.

## 0.1.0

### Minor Changes

- c74bb7bd: Renamed from `@vecto-ui/ui` to `@vectojs/ui` and reset the version to `0.1.0`,
  matching the same-day `@vectojs/core` rescope. See that package's changelog for details.
  This is a clean version reset, not a feature release.

---

## Pre-rebrand history (`@vecto-ui/ui`)

Everything below shipped under the old `@vecto-ui` npm scope, before the 2026-07-01 rename
and version reset. Kept for historical reference — none of these version numbers exist under
the current `@vectojs/ui` scope.

## 0.4.2

### Patch Changes

- Refactor core package into modular subpath exports (`./layout`, `./renderer`, `./text`) and introduce static registration APIs (`Scene.registerWebGLPointRendererCreator`, `Scene.registerWebGPUParticleSystemManager`) for pluggable backends.
- Updated dependencies
  - @vectojs/core@0.9.2

## 0.4.1

### Patch Changes

- Fix WebGPU particle vertex storage binding and align CPU/GPU spring limits. Adjust Scene maxFPS to default to 60 with idle auto-throttling. Fix ScrollView stability and expose public scroll APIs. Add GFM Table support to Markdown component. Adjust UI peerDependencies.
- Updated dependencies
  - @vectojs/core@0.9.1

## 0.4.0

### Minor Changes

- Add high-performance WebGPU Compute-Shader based particle system simulation and UAX #9 compliant bidirectional (BiDi) text layout engine with Arabic/Hebrew/Persian contextual shaping, along with caret navigation and visual highlights in Input and TextArea.

### Patch Changes

- Updated dependencies
  - @vectojs/core@0.9.0

## 0.3.3

### Patch Changes

- Updated dependencies
  - @vectojs/core@0.8.0

## 0.3.2

### Patch Changes

- feat(a11y): strengthen a11yRoot with strict DFS DOM ordering, typing synchronization protection, and full WAI-ARIA keyboard navigation for Dropdown.
- Updated dependencies
- Updated dependencies [cd3e3e8]
  - @vectojs/core@0.7.1

## 0.3.1

### Patch Changes

- Updated dependencies [3dfbfd4]
  - @vectojs/core@0.7.0

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

  - **`@vectojs/core`**: new pure `computeLineSegments(top, bottom, maxWidth, exclusions)` returns the free horizontal segments left on a line after subtracting the `ExclusionRect`s that overlap its band (left/right floats narrow the line; a centered rect splits it in two; a full-width one skips the band). `LayoutEngine.layoutPrepared` takes an optional third `exclusions` argument and flows words across those per-line segments. New exports: `ExclusionRect`, `LineSegment`, `computeLineSegments`. The single-column path (no exclusions) is byte-for-byte unchanged.
  - **`@vectojs/ui`**: `RichText` gains an `exclusions` option and a `setExclusions()` method.

- b5e2c76: Inline rich-text flow (战役一, PR A): bold / italic / colored / differently-sized runs that flow and wrap on the same lines, sharing a baseline.

  - **`@vectojs/core`**: new `LayoutEngine.prepareRich(spans, atlas, baseFontSize, baseStyle?)` cold pass taking `StyledSpan[]`. Each grapheme carries the (base-merged) `TextStyle` of the span it came from — so a style change _mid-word_ is honored — and is measured at its run's `fontSize`. `layoutPrepared` now baseline-aligns mixed sizes (tallest run on a line drives line height; smaller glyphs drop to the shared baseline) and carries `style` onto each `LayoutNode`. New exports: `TextStyle`, `StyledSpan`; `PreparedGlyph`/`LayoutNode` gain an optional `style`. Plain (single-style) layout is unchanged.
  - **`@vectojs/ui`**: new `RichText` component — renders styled runs via the engine's rich path, drawing each glyph with its run's color and weight/slant.

- 90a4339: Inline links in rich text (战役一, PR A.5): a `{ href }` run in a `RichText` is underlined and painted in the link color on the canvas, and projects a real, operable `<a href>` shadow node so screen readers announce it and automation agents (Playwright / AI) can find it by href and click it — routing back to `onLinkClick`.

  - **`@vectojs/core`**: new public `Scene.detachA11y(entity)` to prune the shadow node(s) of an entity subtree on demand. Interactive _child_ entities (e.g. per-link hotspots) call this when they are removed, so the per-frame `syncA11y` (which only creates/updates) never leaks stale nodes.
  - **`@vectojs/ui`**: `RichText` gains `linkColor` and `onLinkClick` options. Each contiguous `href` run gets one transparent `<a>` hotspot child, kept stable across re-wrap (one per run) and pruned when the links change. Link glyphs render with the link color plus an underline.

- cd28e58: Streaming / typewriter rich text (战役一, PR C — "流式打字机"): re-laying out a growing styled document is now O(changed paragraph) instead of O(document).

  - **`@vectojs/core`**: `LayoutEngine.prepareRich` now memoizes per paragraph (mirroring the plain `prepare` memo), keyed by `fontSize` + text + a _value_-based run-length signature of the inline styles. A streaming caller that appends styled runs reuses every untouched leading paragraph by reference — even if it passes fresh style objects with the same values. The memo is invalidated when the font atlas changes.
  - **`@vectojs/ui`**: `RichText.appendSpans(spans)` and `Text.append(text)` for incremental streaming; both re-lay out through the paragraph memo.

- 7a702a8: Add a multi-line `TextArea` component (战役二).

  - **`@vectojs/ui`**: new `TextArea` — a multi-line field backed by a real, transparent `<textarea>` shadow node. The browser owns editing (keyboard, IME composition, selection, clipboard, undo, multi-line navigation); the canvas mirrors it, re-wrapping the value and drawing text, cross-line selection, and a blinking caret with vertical scroll-to-caret. Exposes a pure `wrapText(value, maxWidth, measure)` helper (offset-aware line wrapping with hard-newline + char-level breaking) and `lineOfOffset()` for caret mapping.
  - **`@vectojs/core`**: the a11y/automation shadow layer now supports `tag: 'textarea'` — `Scene.syncA11y` projects a `<textarea>`, sets its placeholder, syncs its value, and forwards its `input`/`change`/selection/IME events back to the entity (previously only `<input>` was wired).

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
  - @vectojs/core@0.6.0

## 0.2.3

### Patch Changes

- 9253e61: Memoize `measureText` with a bounded LRU cache (`(font, text) → width`).

  Native canvas `measureText` forces a layout/context switch on every call. Hot paths re-measure the same strings each frame — `wrapLines` (per-word candidates) and `Input` caret positioning (growing prefixes) — so a 1000-entry LRU keeps the working set hot while capping memory for dynamic text. Behavior is unchanged; repeated measurements are just served from cache.

- c1d428f: Add a scrollable viewport (`ScrollView`) with clipping + wheel scrolling.

  - `core`: `Entity.clipChildren` (Scene clips a node's children to its local box) and a forwarded `'wheel'` event from the shadow node (non-passive, so a scroll container can `preventDefault()` the page scroll).
  - `ui`: `ScrollView({ width, height })` — nests children in a clipped content layer, scrolls on wheel with a damped spring, and clamps to the content bounds. Unblocks scrollable docs/long-list pages built with VectoJS.

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
  - @vectojs/core@0.5.3

## 0.2.2

### Patch Changes

- 7c9e40c: Docs: rewrite READMEs for accurate positioning and honest, reproducible numbers.

  Removes the fabricated "React vs core" comparison table (1k/10k/100k → React
  "Crash" vs "60 FPS") and the misleading "60 FPS with 100,000+ entities" tagline.
  READMEs now describe VectoJS as a Zero-DOM canvas UI runtime with the a11y/agent
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
  - @vectojs/core@0.5.2

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
  - @vectojs/core@0.5.1

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
  - @vectojs/core@0.5.0

## 0.1.4

### Patch Changes

- Updated dependencies [a888e97]
- Updated dependencies [f68ade4]
  - @vectojs/core@0.4.0

## 0.1.3

### Patch Changes

- Updated dependencies [42819e7]
- Updated dependencies [3eb0910]
  - @vectojs/core@0.3.0

## 0.1.2

### Patch Changes

- 6fe2997: Fix the published dependency on `@vectojs/core`.

  Previous releases (0.1.0, 0.1.1) shipped with `"@vectojs/core": "workspace:*"`
  in the published `package.json` — the workspace protocol was not rewritten at
  publish time, so `npm install @vectojs/ui` failed with `EUNSUPPORTEDPROTOCOL`.
  The dependency is now a real semver range (`^0.2.0`), which bun still links
  locally in the monorepo and changesets keeps in sync on future core releases.

## 0.1.1

### Patch Changes

- Updated dependencies [cd59328]
- Updated dependencies [cd59328]
- Updated dependencies [6463b61]
  - @vectojs/core@0.2.0

## 0.1.0

### Minor Changes

- e3b05d3: Add `@vectojs/ui` — high-level canvas UI components rendered to a `<canvas>`
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
