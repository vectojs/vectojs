# @vecto-ui/ui

High-level canvas UI components for [VectoUI](https://github.com/Xuepoo/vecto-ui) — rendered
to a `<canvas>` while projecting a real accessibility/automation shadow node (so the canvas
stays accessible and clickable by screen readers and agents).

```bash
bun add @vecto-ui/ui @vecto-ui/core
```

```typescript
import { Scene } from '@vecto-ui/core';
import { Text, Button, Link } from '@vecto-ui/ui';

const scene = new Scene(document.querySelector('canvas')!);
scene.add(new Text('Welcome', { maxWidth: 300 }).setPosition(20, 20));
scene.add(new Button('Submit', { onClick: () => alert('hi') }).setPosition(20, 80));
scene.add(new Link('Docs', { href: 'https://example.com' }).setPosition(20, 140));
scene.start();
```

| Component | Renders                           | Shadow node                         |
| --------- | --------------------------------- | ----------------------------------- |
| `Text`    | wrapped text                      | `div` with `aria-label`             |
| `Button`  | rounded rect + label, hover state | `<button role="button" aria-label>` |
| `Link`    | underlined colored text           | `<a href>`                          |

## License

MIT © 2026 Xuepoo
