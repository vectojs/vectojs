---
"@vectojs/core": patch
"@vectojs/ui": patch
---

Four interaction / accessibility fixes:

- **`Button` focus ring never appeared** — `render()` drew a ring when `focused`, but nothing set it. Button now syncs `focused` from the `focus`/`blur` events the Scene emits on its shadow `<button>`, so keyboard users get a visible focus indicator.
- **`Link` opened two tabs** — the shadow `<a href target="_blank">` navigates natively on a real DOM click, and that click was also forwarded to the entity's handler which called `window.open` again. Link now skips `window.open` when the click is a genuine DOM click on an `<a>` (native navigation already happened), while still opening for canvas/Three/XR-path clicks where no anchor navigated.
- **`Modal` had no dialog semantics** — it now reports `role="dialog"` + `aria-modal="true"` (new `A11yAttributes.ariaModal`, synced by `Scene`), closes on `Escape`, moves focus into the dialog on open, and restores focus to the previously-focused element on close.
- **`Overlay.hide()` left it interactive and announced** — setting `opacity = 0` alone kept the overlay hit-testable, focusable, and read by screen readers. `hide()` now also clears `interactive` and prunes the a11y/portal shadow subtree (`detachA11y`); a later `showAt`/`showAtPoint` re-shows it and the per-frame sync re-creates the shadow nodes.
