# @vecto-ui/ui

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
