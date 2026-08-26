# @vectojs/styles

`@vectojs/styles` is a thin declarative layer over `@vectojs/core`: write styles with CSS property
names and CSS-like values, and `applyStyle` maps them onto the numeric entity fields of the
Virtual Math Tree. It depends only on `@vectojs/core`, sits beside `@vectojs/ui` in application
code, and is deliberately not a CSS engine — no parser, no selector, no cascade, no inheritance;
the canvas stays the single source of truth.

## Install

```bash
bun add @vectojs/styles
```

Depends on `@vectojs/core` (`^1.39.0`), which is installed automatically.

## Usage

```ts
import { Scene } from '@vectojs/core';
import { Button, Stack } from '@vectojs/ui';
import { applyStyle, css, PRESET_THEMES, setTheme, style, tokens } from '@vectojs/styles';

const scene = new Scene(document.querySelector<HTMLCanvasElement>('canvas')!);
setTheme(tokens(PRESET_THEMES.dark));

const primary = css(
  style({ backgroundColor: 'var(--accent)', borderRadius: 'var(--radius-md)', color: '#fff' }),
  { padding: 12 },
);
const muted = css(primary, { backgroundColor: 'var(--muted)' });

const button = new Button('Deploy');
applyStyle(button, muted);

const row = new Stack({ direction: 'horizontal' });
applyStyle(row, style({ flexDirection: 'row', gap: '8px', alignItems: 'center' }));
row.add(button);
scene.add(row.setPosition(40, 40));
```

## Highlights

- Typed CSS-property-name style objects: `style()` types an object literal as a `Style`;
  `applyStyle(entity, style)` writes the mapped fields, marks the scene dirty, returns the applied
  CSS keys, skips keys the entity does not have, and throws loudly on invalid values or
  container-only keys applied to non-containers.
- Token themes with `var(--key)` references resolved against a flat theme — `setTheme(theme)`
  re-applies every tracked style; unknown tokens, unsupported `var(--key, fallback)`, and
  reference cycles all throw with the offending chain.
- `css(...styles)` merge factory: later sources win, falsy sources are skipped for conditional
  variants, inputs are never mutated (per-axis `padding` objects are copied).
- Preset token sets in `PRESET_THEMES`: `light`, `dark`, `github`, `dracula`; compose your own
  with `tokens(set)` and read back the active theme with `getTheme()`.
- Font composition: `fontFamily` / `fontSize` / `fontWeight` merge into the entity's full canvas
  `font` shorthand preserving unchanged segments, or compose explicitly with `composeFont`.
- Layout keywords map to containers: `flexDirection`, `gap`, `alignItems`, `flexWrap`, and
  `display: 'flex'` (validation-only) work on Stack/Flow entities; per-axis `padding` accepts
  `{ x, y }`.

> Documents @vectojs/styles@0.3.3.

## Documentation

- [`@vectojs/styles` reference](https://vectojs.org/reference/styles/)
