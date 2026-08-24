---
'@vectojs/core': minor
---

Scene-level keyboard channel: `scene.on/off('keydown'|'keyup')` with a new
`SceneKeyEvent` payload, `registerShortcut`/`unregisterShortcut` chord sugar,
and window bubble-phase wiring attached at `start()` and removed only at
`destroy()`. Handlers are suppressed by native `defaultPrevented`, key
auto-repeat, and keyboard-owning focus (`ownsKeyboard(document.activeElement)`).
New exports: `SceneKeyEvent`, `SceneShortcutSpec`, `normalizeChord` (promoted
from `@vectojs/desktop`, which now re-imports it from core), `ownsKeyboard`,
`KEYBOARD_OWNING_ROLES`.
