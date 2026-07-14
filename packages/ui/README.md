# @vectojs/ui

> Canvas-native components with a real semantic/input projection for accessibility and automation.

[![npm](https://img.shields.io/npm/v/@vectojs/ui?color=22d3ee)](https://www.npmjs.com/package/@vectojs/ui)
[![CI](https://github.com/vectojs/vectojs/actions/workflows/ci.yml/badge.svg)](https://github.com/vectojs/vectojs/actions/workflows/ci.yml)
[![MIT](https://img.shields.io/badge/license-MIT-6366f1.svg)](https://github.com/vectojs/vectojs/blob/main/LICENSE)

`@vectojs/ui` supplies layout, form, content, data, navigation, and overlay components for
`@vectojs/core`. The visible UI is painted on canvas. Interactive components project transparent
native/ARIA counterparts so screen readers, keyboard users, Playwright, and AI agents can operate
them by role and accessible name.

[Live component gallery](https://vectojs.org/reference/ui-components/#live-component-gallery) ·
[Component reference](https://vectojs.org/reference/ui-components/) ·
[Getting started](https://vectojs.org/learn/getting-started/)

## Install

```bash
bun add @vectojs/core @vectojs/ui
```

`@vectojs/core` is a peer dependency and should be installed explicitly.

Applications that only need the native text field, selectable static text, or text-measurement
helpers can use lightweight subpaths. They exclude content-rendering dependencies such as Markdown
and MathJax from the application bundle:

```ts
import { Input } from '@vectojs/ui/input';
import { Text } from '@vectojs/ui/text';
import { measureText, wrapLines } from '@vectojs/ui/measure';
```

## Example

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
  new Input({
    width: 300,
    placeholder: 'Project name',
    onChange: (name) => (state.name = name),
  }),
);
form.add(new Toggle({ checked: state.enabled, label: 'Enabled' }));
form.add(new Slider({ min: 0, max: 100, value: state.quality, width: 300 }));
form.add(new Button('Export', { onClick: () => console.log(state) }));

const card = new Card({ width: 360, height: 310, padding: 24, label: 'Export settings' });
card.add(form);
scene.add(card.setPosition(40, 40));
scene.start();
```

Automation uses the projected controls, not pixel coordinates:

```ts
await page.getByRole('textbox', { name: 'Project name' }).fill('Launch');
await page.getByRole('switch', { name: 'Enabled' }).click();
await page.getByRole('button', { name: 'Export' }).click();
```

## Component catalog

| Category         | Components                                                                              |
| ---------------- | --------------------------------------------------------------------------------------- |
| Typography       | `Text`, `RichText`, `Link`, `measureText`, `wrapLines`, `wrapText`                      |
| Layout           | `Card`, `Stack`, `Flow`, `ScrollView`                                                   |
| Forms            | `Button`, `Input`, `TextArea`, `Checkbox`, `Toggle`, `Slider`, `Dropdown`, `RadioGroup` |
| Content          | `Image`, `Markdown`, `CodeBlock`, `Table`                                               |
| Navigation/data  | `Tabs`, `TreeView`, `VirtualList`, `ProgressBar`                                        |
| Resizable layout | `PanelGroup`, `Panel`, `PanelResizeHandle`                                              |
| Transient UI     | `Overlay`, `Tooltip`, `Popover`, `ContextMenu`, `Modal`                                 |

The [live gallery](https://vectojs.org/reference/ui-components/#live-component-gallery)
renders every public visual component with the published package.

## Native input and semantic projection

`Input` and `TextArea` are backed by transparent native controls. The browser remains responsible
for IME composition, selection, clipboard, undo, and text editing; VectoJS mirrors value, selection,
composition range, caret, and scrolling onto canvas.

Other controls expose role/name/state through `getA11yAttributes()`. This makes them discoverable,
but applications must still provide meaningful labels and validate focus order, keyboard behavior,
contrast, error messaging, and reduced-motion behavior.

Static `Text`, `RichText`, `Markdown`, fenced `CodeBlock`, and `Table` cell text use Core content
projection for browser-native drag selection, Ctrl/Command+C, and find-in-page. Selection is enabled
by default to preserve the existing UI behavior and can be configured or changed at runtime:

```ts
const markdown = new Markdown(source, { maxWidth: 640, selectable: false });
markdown.setSelectable(true);

const label = new Text('Copy me', { selectable: true });
label.setSelectable(false);
```

The transparent projection carries semantics and native text machinery only; layout and pixels
remain owned by VMT entities. Application-level shortcut routers must yield native copy when
`window.getSelection()?.isCollapsed === false` and must not suppress Ctrl/Command+F unless the
application intentionally replaces browser find.

`CodeBlock` uses Core's retained prepared-content grid for both canvas paint and the semantic text
carrier. This keeps source copy/find and selection aligned across Chromium and Firefox under font
substitution, DPR, browser zoom, forced colors, rotation, non-uniform scaling, tabs, CJK, emoji,
Arabic shaping, and mixed-direction text. `Markdown` list and table text and standalone `Table`
cells use the same pointer-selection contract; structural table semantics do not intercept their
content projections.

## Layout and streaming guidance

- `Stack` and `Flow` position children; call `layout()` after changing child dimensions directly.
- `Table` normalizes string cells into `Text` children and performs geometry in `layout()` rather
  than during drawing. Call `table.layout()` after changing an Entity cell's content or dimensions.
- `ScrollView`, `VirtualList`, and `TreeView` own clipped scrolling behavior. Do not place them inside
  a page region that also captures the same wheel gesture without a clear boundary.
- Use `Text.setMaxWidth()` for hot reflow instead of rebuilding text.
- Use `RichText.appendSpans()` and `Markdown.appendMarkdown()` for streams. Repeatedly calling
  `setContent(fullDocument)` rebuilds the rendered tree.
- Pass `MarkdownOptions.onLinkClick` when Markdown links should route through application code
  instead of opening directly.
- In `onDemand` scenes, built-in form controls and buttons mark their scene dirty on visual state
  changes. Custom components should do the same from event handlers that affect rendering.
- Overlays mount through the Scene overlay root so they escape normal clipping. Destroy or hide
  transient UI when its target leaves the tree.

## Rendering and lifecycle

Components are `Entity` instances. They inherit transforms, opacity, event capture/bubble,
animation, world/local coordinate conversion, and Scene ownership. Remove components from their
parent when finished and call `scene.destroy()` when the canvas runtime unmounts.

## Compatibility

The package follows SemVer. Version 1.9 and later accept `@vectojs/core >=1.8.0 <2.0.0` because the
shared prepared-content grid is part of the Core 1.8 public contract. Pin exact tested releases in
applications and read the changelog before upgrading.

## License

[MIT](https://github.com/vectojs/vectojs/blob/main/LICENSE) © 2026 Xuepoo
