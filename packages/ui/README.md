# @vectojs/ui

`@vectojs/ui` is the component layer that sits directly above `@vectojs/core` in the dependency
graph: layout containers, form controls, content and data views, navigation, and overlays, all
painted on canvas as `Entity` subclasses. It has **zero runtime dependencies** — `@vectojs/core`
is a peer — so applications pull nothing heavier than the components they import. Interactive
components project transparent native/ARIA counterparts, so screen readers, keyboard users,
Playwright, and AI agents operate them by role and accessible name.

## Install

```bash
bun add @vectojs/core @vectojs/ui
```

`@vectojs/core` is a peer dependency (`>=1.25.0 <2.0.0`) and should be installed explicitly.

## Usage

```ts
import { Scene } from '@vectojs/core';
import { Button, Card, Input, Slider, Stack, Text, Toggle } from '@vectojs/ui';

const scene = new Scene(document.querySelector<HTMLCanvasElement>('canvas')!);
scene.renderMode = 'onDemand';

const state = { name: '', quality: 72, enabled: true };
const form = new Stack({ direction: 'vertical', gap: 14 });
form.setPosition(24, 24);
form.add(new Text('Export settings', { font: '700 22px Inter' }));
form.add(
  new Input({ width: 300, placeholder: 'Project name', onChange: (name) => (state.name = name) }),
);
form.add(new Toggle({ checked: state.enabled, label: 'Enabled' }));
form.add(new Slider({ min: 0, max: 100, value: state.quality, width: 300 }));
form.add(new Button('Export', { onClick: () => console.log(state) }));

const card = new Card({ width: 360, height: 310, padding: 24, label: 'Export settings' });
card.add(form);
scene.add(card.setPosition(40, 40));
scene.start();
```

## Highlights

- Full component catalog: `Text`, `RichText`, `Link` typography; `Stack`, `Flow`, `Card`,
  `ScrollView` layout; `Button`, `Input`, `TextArea`, `Checkbox`, `Toggle`, `Slider`, `Dropdown`,
  `RadioGroup` forms; `Image`, `Table` content; `Tabs`, `TreeView`, `VirtualList`,
  `ProgressBar`; `PanelGroup`/`Panel`/`PanelResizeHandle` resizable layouts; `Overlay`,
  `Tooltip`, `Popover`, `ContextMenu`, `Modal` transient UI.
- Native input projection: `Input` and `TextArea` are backed by transparent native controls, so
  IME composition, selection, clipboard, undo, and text editing stay browser-native while value,
  caret, and scrolling are mirrored onto canvas.
- Semantic a11y on every control through `getA11yAttributes()` — role, name, state, and roving
  `tabIndex` — making whole forms drivable via `page.getByRole(...)` without pixel coordinates.
- Static text selection: `Text`, `RichText`, and `Table` cells project selectable content with
  `setSelectable()`, giving browser-native drag selection, Ctrl/Command+C, and find-in-page over
  canvas-painted text.
- Lightweight subpaths keep small bundles small: `@vectojs/ui/input`, `@vectojs/ui/text`,
  `@vectojs/ui/measure` (`measureText`, `wrapText`, font-metrics change notifications),
  `@vectojs/ui/context-menu`.
- Hot reflow and streaming primitives: `Text.setMaxWidth()` / `RichText.setMaxWidth()` reflow
  without rebuilding; `RichText.appendSpans()` appends spans for token-stream UIs.
- Components are plain `Entity` instances — transforms, opacity, event capture/bubble, animation,
  and Scene ownership all carry over from Core.

> Documents @vectojs/ui@2.20.1.

## Documentation

- [Components reference](https://vectojs.org/reference/ui-components/)
- [UI components guide](https://vectojs.org/learn/ui-components/)
- [Getting started](https://vectojs.org/learn/getting-started/)
