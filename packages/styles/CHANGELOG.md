# @vectojs/styles

## 0.3.3

### Patch Changes

- c97da27: fix(styles/desktop/table/markdown-app): clear the 2026-08 review backlog (#661)

  **@vectojs/desktop**

  - Remove unused public API: `DisplayLayout.setTaskbar` (DesktopShell reads the
    config directly; zero callers in src or tests) and `Vfs.baseName` (zero
    consumers anywhere).
  - `Window.updateChrome` reads chrome values from the merged `this.chrome` after
    `Object.assign`, so a partial argument cannot clobber shell bg/border/radius
    and titlebar colors with undefined (latent today — both call sites pass full
    resolveChrome objects).
  - `DesktopShell.setTheme` closes an open StartMenu first: the menu is not
    remounted by the swap and kept old colors plus a stale taskbar anchor.
  - Taskbar `entriesHost` clips children, so overflowing entries stop painting
    over the clock area.

  **@vectojs/styles**

  - Font shorthand accepts a second/third `normal` (`font: normal normal 16px
Inter`): after the weight slot takes the first (documented compat choice),
    further `normal`s fill style then variant instead of falling into the size
    slot and throwing TypeError.
  - Dropped internal `resolveStyle().hadVar`: computed but never read by any
    consumer including tests.

  **@vectojs/table**

  - Virtual row window upper bound is exact (`ceil(x) + overscan - 1`, matching
    `i*rh < scrollY + viewport + overscan*rh`); it previously mounted one extra
    fully-invisible row past the overscan budget per window.

  **@vectojs/markdown-app**

  - `MarkdownApp.setTheme` throws a TypeError listing valid presets on unknown
    theme names instead of silently no-oping, matching the fail-loud convention
    used across these packages.

- baa6a18: Composite `var()` values, font shorthand prefixes, and loud edge failures (GH-608).

  `var()` references embedded inside a larger string — `'rgba(var(--rgb), 0.4)'`
  — were neither resolved, tracked, nor rejected: the literal garbage was written
  to the entity field while Canvas2D silently kept the old value. Embedded
  references now resolve by substitution, chains of token-references-token
  resolve transitively with path-based cycle detection, and the key is tracked so
  theme switches re-resolve composites. Unknown tokens and cycles throw with the
  offending chain.

  The font shorthand parser understands the full canvas prefix grammar
  `[style || variant || weight]? size[/line-height]? family`. `italic 700 16px
Georgia` and `16px/24px Inter` used to collapse everything around the size into
  the family, so a later segment change recomposed an invalid string that
  Canvas2D drops; size-like segments that cannot be placed now fail loudly, and
  line-height segments survive a size change.

  `fontSize` enforces its `${number}px` type at runtime: non-px units arriving
  through tokens or JS callers used to compose a silently-dropped shorthand and
  now throw.

  `css()` copies per-axis `padding` objects into the merged result, so the
  documented "fresh plain object / does not mutate inputs" contract holds for
  nested values too.

- fcd99e2: fix(styles): `var(--token, fallback)` now fails loudly instead of passing through unresolved (#645)

  `HAS_VAR_RE` requires `)` immediately after the key characters, so the CSS
  fallback form matched no regex: `resolveValue` passed the raw string through to
  mapped fields (Canvas2D silently kept the previous paint — the exact GH-608
  failure mode) and `trackVarKeys` never registered it, so theme switches never
  updated it. A new shared `HAS_VAR_FALLBACK_RE` detects the form anywhere it can
  arrive — direct value, embedded in a composite string, inside a padding axis,
  or through a token chain — and throws a targeted `TypeError` naming the
  offending value. Fallback resolution itself remains unimplemented; silence was
  the defect. README rules-of-road updated.

- d910402: fix(styles): fallback detector tolerates whitespace after `var(` (#753 follow-up)

  `HAS_VAR_FALLBACK_RE` required the custom property to start immediately after
  the opening paren, so `var( --accent, #fff)` matched none of the three var()
  forms and passed through silently unresolved — reaching mapped fields as a
  literal string while Canvas2D kept the previous paint, exactly what #645's
  guard exists to prevent.

  The detector now allows whitespace between `var(` and `--key` (`/var\(\s*--/`),
  kept conservative: whitespace only, not the full CSS token grammar.

- b4b215e: fix(styles): theme var() tracking no longer retains destroyed entities strongly (#644)

  `varPairs` was `WeakMap<Theme, Map<Entity, …>>` — only the outer key was weak,
  so the inner map held every styled entity strongly for the lifetime of its
  theme. `Entity.destroy()` has no hook back into styles, so destroyed entities
  stayed reachable and every `setTheme` re-resolved and re-wrote their styles
  forever; retention grew unboundedly with styled-entity churn while a theme
  stayed active. Entities are now tracked through stable `WeakRef`s (dead entries
  swept during the setTheme walk) and a new exported `untrackVarStyles(entity)`
  gives frameworks an eager, deterministic release path for destroy teardown.

- Updated dependencies [01d1141]
- Updated dependencies [2474ab3]
- Updated dependencies [b87a455]
- Updated dependencies [6e76253]
- Updated dependencies [69bb9fa]
- Updated dependencies [cb02dad]
- Updated dependencies [2568021]
- Updated dependencies [f492f4e]
- Updated dependencies [1f7e41e]
- Updated dependencies [592f492]
- Updated dependencies [c7290f1]
- Updated dependencies [b0955f2]
- Updated dependencies [488b62b]
- Updated dependencies [21b0e05]
- Updated dependencies [e6accf6]
- Updated dependencies [5ece3e2]
- Updated dependencies [3c08f97]
- Updated dependencies [b9bd582]
- Updated dependencies [1d0962c]
- Updated dependencies [825442e]
- Updated dependencies [02447ad]
  - @vectojs/core@1.39.0

## 0.3.2

### Patch Changes

- 3283905: Fix the 2026-08-13 full-repo review's lower-severity findings (P3):

  - `@vectojs/graph3d`: `Graph3D.setGraphData` now resolves link endpoints before clearing or attaching anything, so a link naming an unknown id throws while the previous graph stays fully intact (it used to leave a half-built graph in the scene). `GraphInteraction.dispose()` during an active drag now runs the finish path, re-enabling host controls and firing `onDragEnd` (they previously stayed disabled forever). `VectoForceLayout`: exactly-coincident unlinked nodes now separate — the octree stores coincident points as distinct deterministic-jittered leaves, the repulsion skip identifies the query point's own leaf by identity instead of `d2 === 0` (which also skipped coincident _other_ points), and the flat octree arrays grow past the 8n+8 bound instead of silently dropping typed-array writes into NaN forces; the class docstring now correctly states that the octree accumulates in f64 while positions/velocities stay f32.
  - `@vectojs/three`: `ThreeAdapter` no longer dispatches a duplicate/spurious `pointerleave` to the entity under the last hover position when the pointer exits the mesh. `ThreeRenderer.fillText` rasterizes at the renderer pixel ratio and keys its texture cache on DPR, so HiDPI displays stop rendering blurry glyphs. `fillCircle`, solid path fills, gradient fills and `drawImage` materials are now `DoubleSide`, fixing the mirrored y-down ortho projection culling their FrontSide geometry (the fillText fix from #511 applied to every remaining mesh path).
  - `@vectojs/video-exporter`: `normalizeOptions` rejects odd width/height up front — H.264 yuv420p cannot encode them and previously only failed with raw ffmpeg stderr at the very end of the export.
  - `@vectojs/styles`: the `fontSize` style type is narrowed to a unit-bearing `${number}px` string, matching the runtime rejection of bare numbers (numeric `var()` tokens still throw the targeted error). `var()` tokens that reference other tokens now resolve transitively with cycle detection, instead of leaking the literal `var(--…)` into string fields that Canvas2D silently ignored.

- ae13ded: Make `setTheme` atomic on token-resolution failure: every tracked style is now resolved against the next theme before the active theme changes, so a theme missing a referenced token throws while the scene, theme and pair bookkeeping stay fully under the previous theme (previously entities were left half-restyled and pairs half-migrated). And fix `ThreeRenderer.fillText` placement: parse the size out of the weight-first font shorthand (`'700 16px Inter'` produced a 1050px texture before), keep the raster texture unflipped so glyphs stay upright under the y-down ortho camera, draw the plane double-sided so it survives the mirrored projection's culling, and position the mesh so the alphabetic baseline lands exactly at the Canvas2D `y`.
- Updated dependencies [bfc3c9c]
- Updated dependencies [031789a]
- Updated dependencies [d86f5ce]
- Updated dependencies [e41dd95]
- Updated dependencies [32664a4]
- Updated dependencies [e2e26d6]
  - @vectojs/core@1.35.2

## 0.3.0

### Minor Changes

- 6263146: Fix theme-switch var() tracking (GH-451): per-entity tracking is now key-level, so multiple var() styles on one entity accumulate and a later literal on the same key stops being replayed on switch.

  Fix font token semantics (GH-452): preset themes gain independent `fontFamily`/`fontSize`/`fontWeight` tokens; `fontSize` fed a bare-number token and `fontFamily` fed the `font` shorthand token now throw loudly instead of corrupting the composed font string.

  Document the property x component support matrix in the README (GH-453): `textAlign` is `left|justify` only, `borderColor` silently skips components without the field, and container detection is by field presence.

## 0.3.1

### Patch Changes

- 4475d3a: Fix the polynomial-redos code-scanning alert (js/polynomial-redos) on the font
  size parser: the `(\d+\.?\d*|\.\d+)` number pattern overlapped adjacent digit
  classes, so a long digit run with a non-unit suffix backtracked in O(n²).
  Replaced with `(?:\d+(?:\.\d*)?|\.\d+)` (digit class separated by a literal
  dot) and reordered the unit alternation so `em`/`rem` is never a prefix pair —
  long malformed values now fail in linear time.

## 0.2.0

### Minor Changes

- 5982253: Add the token/theme layer to `@vectojs/styles` (0.2.0):

  - `tokens(set)` + `setTheme(theme)` / `getTheme()` — flat token sets
    (`markdown/src/theme.ts` precedent); `var(--key)` strings in style values
    resolve against the active theme, and styles that reference tokens are
    re-applied on every theme switch (WeakMap-tracked, no leaks).
  - `css(...styles)` — merge factory for variants; `null`/`false` skipped.
  - `fontFamily`/`fontSize`/`fontWeight` — composed into the entity's font
    shorthand (segment-preserving parse/recompose of the CSS font string).
  - `padding: { x, y }` — per-axis padding; ui `UIComponent` gains
    `paddingX`/`paddingY` fields for consumers that read padding live.
    Button's intrinsic width/height are still fixed at construction.
  - `PRESET_THEMES` — `light`/`dark`/`github`/`dracula` token sets; the
    default theme is the `light` preset.
