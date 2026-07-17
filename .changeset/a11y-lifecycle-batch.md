---
'@vectojs/core': minor
---

Added `Entity.focus()` — programmatic focus for an entity's projected a11y shadow element, with one rAF retry if the element hasn't been created by the next sync yet (closing the "projected element exists only after next a11y sync" gap, findings.md 2026-07-10).

Added `'dblclick'` to the `VectoEvent` union and wired a native `dblclick` listener on each entity's shadow element in `Scene.syncA11y` — same dispatch pattern as `click` (findings.md 2026-07-10: "no dblclick event in core event routing"). The existing `a11yRoot`-level `dblclick` handler for text word-selection fires on the content-projection DOM layer and is unaffected by this change.

Note: `A11yAttributes.tabIndex?: number` (Entity.ts line 183) and `Scene.syncA11y`'s `attrs.tabIndex` read (Scene.ts line 1526) were already shipped in a prior release — the corresponding findings.md entry 2026-07-10 ("keydown unreachable for entities outside INTERACTIVE_ROLES") was already resolved in code but not yet marked in the log; updated in this same pass.
