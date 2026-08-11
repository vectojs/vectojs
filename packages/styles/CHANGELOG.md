# @vectojs/styles

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
