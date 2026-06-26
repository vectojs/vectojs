# @vecto-ui/ui

High-level canvas UI components for [VectoUI](https://github.com/Xuepoo/vecto-ui) — rendered
to a `<canvas>` while projecting a real accessibility/automation shadow node, so the canvas
stays accessible and drivable by screen readers and AI agents (`getByRole(...).click()/.fill()`).

```bash
bun add @vecto-ui/ui @vecto-ui/core
```

```typescript
import { Scene } from '@vecto-ui/core';
import { Stack, Text, Input, Checkbox, Button } from '@vecto-ui/ui';

const scene = new Scene(document.querySelector('canvas')!);
const form = new Stack({ gap: 12 }).setPosition(20, 20);
form.add(new Text('Sign up', { font: '600 24px sans-serif' }));
form.add(new Input({ width: 280, placeholder: 'you@example.com' })); // real <input>, CJK IME-ready
form.add(new Checkbox({ label: 'I accept the terms' }));
form.add(new Button('Create account', { onClick: () => console.log('submit') }));
scene.add(form);
scene.start();
```

## Components

| Component  | Renders                                                       | Shadow node                               |
| ---------- | ------------------------------------------------------------- | ----------------------------------------- |
| `Text`     | wrapped text (via the shared LayoutEngine)                    | `div` with `aria-label`                   |
| `Button`   | rounded rect + label, hover state                             | `<button role="button" aria-label>`       |
| `Link`     | underlined colored text                                       | `<a href>`                                |
| `Image`    | image (placeholder until loaded)                              | `<img alt>`                               |
| `Card`     | rounded panel + optional border                               | `div` (optional `role="group"`)           |
| `Stack`    | vertical/horizontal auto-layout                               | container                                 |
| `Input`    | text field with **caret, selection, IME composing underline** | `<input>` (value flows back via `change`) |
| `Checkbox` | box + check + label                                           | `<input type="checkbox">`                 |
| `Toggle`   | switch track + knob + label                                   | `role="switch"` with `aria-checked`       |

`Input` is backed by a real, transparent `<input>`, so the browser handles native **CJK IME
composition**, selection, clipboard and undo; the canvas mirrors it (blinking caret, selection
highlight, composing underline, scroll-to-caret).

Also exported: `measureText`, `wrapLines`, `fontSizePx` text helpers, and the `UIComponent` base.

## License

MIT © 2026 Xuepoo
