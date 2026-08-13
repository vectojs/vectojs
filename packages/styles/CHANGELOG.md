# @vectojs/styles

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
