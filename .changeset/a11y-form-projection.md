---
'@vecto-ui/core': minor
---

Extend the accessibility/automation shadow layer for media and form controls.

- `A11yAttributes` gains `src`/`alt` (for `tag: 'img'`), `inputType`/`placeholder`/
  `value`/`checked` (for `tag: 'input'`), and `'img'`/`'input'` tags.
- `Scene.syncA11y` now refreshes dynamic attributes (`aria-label`, `value`,
  `checked`/`aria-checked`) every frame, builds `<img>`/`<input>` nodes, and
  forwards a new `change` event from form-control shadow nodes back to the entity
  (without clobbering a field the user is actively typing in).
- `SceneOptions.debugA11y` (default `false`): shadow nodes are now transparent
  (`opacity:0`) by default — still operable by Playwright/assistive tech, but the
  canvas is the only thing rendered. Set `true` for the old blue dashed-outline
  debugging view.
