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
- String values may be `var(--key)` token references resolved against the
  active theme; an unknown token throws.
- `fontFamily` / `fontSize` / `fontWeight` compose into the entity's `font`
  shorthand, preserving the segments the style does not change.
- `padding` accepts a single value or `{ x, y }` (per-axis); box components
  size themselves at construction, so post-construction padding changes are
  picked up only by consumers that read `padding`/`paddingX`/`paddingY` live.
- `flexDirection`/`alignItems`/`flexWrap` take CSS keywords (`row`/`column`,
  `flex-start`/`center`/`flex-end`, `wrap`/`nowrap`).
- Layout keys require a container entity (Stack/Flow); anything else throws.
- `applyStyle` marks the entity's scene dirty when it writes anything.

## Install

```sh
bun add @vectojs/styles
```

Depends only on `@vectojs/core`.
