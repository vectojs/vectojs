# @vectojs/styles

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
