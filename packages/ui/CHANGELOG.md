# @vecto-ui/ui

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
