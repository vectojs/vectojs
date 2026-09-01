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

## Image — `ImageSource`, `DecodedImage` & `semanticMode`

`Image` is canvas-native: `r.drawImage(decoded.source)` with `computeImageFit` on
`decoded.width/height`. The source model and a11y projection are decoupled so
binary bytes never have to become a DOM `src`.

```ts
import type { ImageSource, NormalizedImageSource, DecodedImage } from '@vectojs/ui';

type ImageSource =
  | string
  | { kind: 'url'; url: string }
  | { kind: 'blob'; blob: Blob }
  | { kind: 'bitmap'; bitmap: ImageBitmap };

function normalizeSource(src: ImageSource): NormalizedImageSource {
  return typeof src === 'string' ? { kind: 'url', url: src } : src;
}

interface DecodedImage {
  source: CanvasImageSource;
  width: number;
  height: number;
  dispose?: () => void;
}
```

| kind             | decode                                                                               | ownership                                            |
| ---------------- | ------------------------------------------------------------------------------------ | ---------------------------------------------------- |
| `string` / `url` | `HTMLImageElement`                                                                   | browser                                              |
| `blob`           | `createImageBitmap(blob)` → `ImageBitmap` (fallback `URL.createObjectURL` + `<img>`) | `dispose` closes `ImageBitmap` or revokes object URL |
| `bitmap`         | used directly                                                                        | **caller owns** `ImageBitmap`; `dispose` absent      |

`semanticMode` controls the shadow node (default `'auto'`):

| `semanticMode` | source          | shadow node                                   | note                       |
| -------------- | --------------- | --------------------------------------------- | -------------------------- |
| `auto`         | `url`           | `<img src alt>`                               | crawlable                  |
| `auto`         | `blob`/`bitmap` | `<div role="img" aria-label>`                 | no `blob:` URL synthesized |
| `img`          | `url`           | `<img>`                                       | forced                     |
| `img`          | `blob`/`bitmap` | `<div role="img">` + throttled `console.warn` | never synthesizes `blob:`  |
| `role`         | any             | `<div role="img">`                            | hides URL even for `url`   |

```ts
new Image('/logo.png', { width: 160, height: 80, alt: 'Logo' });
new Image({ kind: 'blob', blob }, { width: 96, height: 96, alt: 'Avatar' });
new Image({ kind: 'bitmap', bitmap }, { width: 96, height: 96, alt: 'Avatar' });
new Image('/cover.jpg', { width: 640, height: 360, alt: 'Cover', semanticMode: 'role' });
```

**Visual Flattening & trust boundary.** Canvas eliminates the hit-target and
native context-menu entry — an image is `drawImage` pixels, not a DOM `<img>` to
hit-test or save. Flattening alone does **not** hide the URL from the a11y tree;
`Image` still projects `<img src>` for `url` sources. Use `semanticMode: 'role'`
(or `auto` + `blob`/`bitmap`) when the URL must not appear.

| Concern           | Guarantee                                                                       | Non-guarantee                                                          | Owner                       |
| ----------------- | ------------------------------------------------------------------------------- | ---------------------------------------------------------------------- | --------------------------- |
| Master asset      | **Never enters client** — only Derived Raster (watermarked, resized) is fetched | Master not served even if Derived URL known                            | Server / pipeline           |
| CapGlyph          | Signal / credential / provenance & watermark params for Derived fetch           | Not a resize service; does not hide Derived URL                        | App adapter                 |
| Visual Flattening | Removes canvas hit-target & context-menu                                        | Does not remove `<img src>` from a11y; needs `semanticMode`            | Canvas path                 |
| `semanticMode`    | `role` / `auto`+non-url keeps bytes off `src`; decoded is canvas-only           | Pixels still readable via `toDataURL`; a11y is not a security boundary | `Image.getA11yAttributes()` |

`Master never enters client` — CapGlyph validates the Derived request and carries
provenance/watermark signal; the package stays free of CapGlyph imports. No
`ProtectedImage` subclass is needed: `Image` + `auto` covers it. See the
[Image reference](https://vectojs.org/reference/ui-image/) for the full cookbook
and `imageResolver` adapter shape.

> Documents @vectojs/ui@2.20.1.

## Documentation

- [Components reference](https://vectojs.org/reference/ui-components/)
- [UI components guide](https://vectojs.org/learn/ui-components/)
- [Getting started](https://vectojs.org/learn/getting-started/)
