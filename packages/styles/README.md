# @vectojs/styles

CSS-property-name style objects for [VectoJS](https://github.com/vectojs/vectojs).

Typed syntax sugar for migrating web habits onto the numeric Virtual Math Tree:
write styles with CSS property names and CSS-like values, and `applyStyle`
maps them onto entity fields. No parser, no cascade, no selector — the canvas
stays the single source of truth.

```ts
import { style, applyStyle } from '@vectojs/styles';

const primary = style({
  backgroundColor: '#2563eb',
  borderRadius: '8px',
  padding: 12,
  color: '#fff',
});

applyStyle(button, primary);
applyStyle(stack, style({ flexDirection: 'row', gap: '8px', alignItems: 'center' }));
```

## Exports

- `style()` — identity factory typing an object literal as `Style`.
- `applyStyle(entity, style)` — writes mapped fields, returns the applied CSS
  keys; skips keys the entity does not have, throws on invalid values and on
  container-only keys applied to non-containers.
- `Style` — the CSS-named style interface.

## Rules of the road

- Values are bare numbers (px) or `px` strings; `%`/`em` are rejected loudly.
- `flexDirection`/`alignItems`/`flexWrap` take CSS keywords (`row`/`column`,
  `flex-start`/`center`/`flex-end`, `wrap`/`nowrap`).
- Layout keys require a container entity (Stack/Flow); anything else throws.
- `applyStyle` marks the entity's scene dirty when it writes anything.

## Install

```sh
bun add @vectojs/styles
```

Depends only on `@vectojs/core`.
