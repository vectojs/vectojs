# @vectojs/styles

CSS-property-name style objects for [VectoJS](https://github.com/vectojs/vectojs).

Typed syntax sugar for migrating web habits onto the numeric Virtual Math Tree:
write styles with CSS property names and CSS-like values, and `applyStyle`
maps them onto entity fields. Token references (`var(--key)`) resolve against
a flat theme, and switching the theme re-applies every tracked style. No
parser, no cascade, no selector — the canvas stays the single source of truth.

```ts
import { style, applyStyle, css, tokens, setTheme, PRESET_THEMES } from '@vectojs/styles';

setTheme(tokens(PRESET_THEMES.dark));

const primary = css(
  style({ backgroundColor: 'var(--accent)', borderRadius: 'var(--radius-md)', color: '#fff' }),
  { padding: 12 },
);
const muted = css(primary, { backgroundColor: 'var(--muted)' });

applyStyle(button, muted);
applyStyle(stack, style({ flexDirection: 'row', gap: '8px', alignItems: 'center' }));
applyStyle(title, style({ fontFamily: 'Inter', fontSize: '18px', fontWeight: 700 }));
```

## Exports

- `style()` — identity factory typing an object literal as `Style`.
- `css(...styles)` — merge factory; later sources win, `null`/`false` skipped.
- `applyStyle(entity, style)` — writes mapped fields, returns the applied CSS
  keys; skips keys the entity does not have, throws on invalid values and on
  container-only keys applied to non-containers.
- `tokens(set)` / `setTheme(theme)` / `getTheme()` — flat token sets; styles
  referencing `var(--key)` are re-applied when the theme switches.
- `PRESET_THEMES` — `light` / `dark` / `github` / `dracula` token sets.
- `Style` — the CSS-named style interface.

## Rules of the road

- Values are bare numbers (px) or `px` strings; `%`/`em` are rejected loudly.
  This holds for `fontSize` at runtime too — tokens and JS callers bypass the
  `${number}px` type, so non-px units fail loudly instead of composing a
  shorthand Canvas2D silently drops.
- String values may be `var(--key)` token references resolved against the
  active theme; an unknown token throws. References embedded inside a larger
  string (`'rgba(var(--rgb), 0.4)'`) resolve by substitution as well, and
  chains of token-references-token resolve transitively with cycle detection —
  any cycle or missing token throws with the offending chain.
- `fontFamily` / `fontSize` / `fontWeight` compose into the entity's `font`
  shorthand, preserving the segments the style does not change. The parser
  understands the full canvas prefix grammar
  `[style || variant || weight]? size[/line-height]? family`; a stored
  shorthand with an unrecognized size-like segment throws instead of being
  silently recomposed into something invalid.
- `css(...)` produces a fresh object and never aliases its inputs — per-axis
  `padding` objects are copied into the merged result.
- `padding` accepts a single value or `{ x, y }` (per-axis); box components
  size themselves at construction, so post-construction padding changes are
  picked up only by consumers that read `padding`/`paddingX`/`paddingY` live.
- `flexDirection`/`alignItems`/`flexWrap` take CSS keywords (`row`/`column`,
  `flex-start`/`center`/`flex-end`, `wrap`/`nowrap`).
- Layout keys require a container entity (Stack/Flow); anything else throws.
- `applyStyle` marks the entity's scene dirty when it writes anything.

## Property support matrix (GH-453)

Not every CSS-named property maps to every component — `applyStyle` skips keys
whose field does not exist on the entity (shared styles) and throws on
container-only keys applied to non-containers. What that means in practice:

| Property                                                    | Works on                                                | Notes                                                                                                                                                                                          |
| ----------------------------------------------------------- | ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `x`/`y`/`width`/`height`, `opacity`, `scaleX/Y`, `rotation` | any entity with the field                               | `rotation` is radians, not degrees.                                                                                                                                                            |
| `backgroundColor`, `color`                                  | components with `bg` / `color` (Button, Card, Text, …)  | `Button` has no `borderColor` — the key is skipped silently on it.                                                                                                                             |
| `borderColor`                                               | components that expose `borderColor` (Card, Popover, …) | Silently skipped elsewhere by design (shared-style contract).                                                                                                                                  |
| `borderRadius`                                              | components with `radius` (Button, Card, …)              |                                                                                                                                                                                                |
| `font` / `lineHeight`                                       | text-bearing components (Text, RichText, Input, …)      | `font` is the full shorthand.                                                                                                                                                                  |
| `fontFamily`/`fontSize`/`fontWeight`                        | text-bearing components                                 | Compose into the `font` shorthand. `fontSize` needs a unit-bearing token; `fontFamily` must not reference the `font` shorthand token — both throw loudly.                                      |
| `textAlign`                                                 | `Text`/`RichText`/`TextEntity` (via `setTextAlign`)     | Only `left` and `justify` exist in the stack; `center`/`right` throw (revisit when ui Text supports them).                                                                                     |
| `padding`                                                   | components with `paddingX`/`paddingY` (ui components)   | Sizing is fixed at construction; consumers that read the fields live pick changes up.                                                                                                          |
| `display`/`flexDirection`/`gap`/`alignItems`/`flexWrap`     | Stack/Flow containers                                   | `display: flex` is validation-only. Container detection is "has a `direction` field", so any entity carrying `direction` accepts these keys — give non-layout entities a different field name. |

## Install

```sh
bun add @vectojs/styles
```

Depends only on `@vectojs/core`.
