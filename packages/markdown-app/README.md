# @vectojs/markdown-app

`@vectojs/markdown-app` is a ready-made canvas-native Markdown reader and source workbench built
from framework packages: it composes the `Markdown` engine from `@vectojs/markdown` with
`TextArea`, `ScrollView`, `Dropdown`, `Toggle`, and `Stack` from `@vectojs/ui` on top of
`@vectojs/core`. It has no runtime dependencies of its own — all three framework packages are
peers — and is intentionally a focused shell, not an application.

## Install

```bash
bun add @vectojs/core @vectojs/ui @vectojs/markdown @vectojs/markdown-app
```

Peers: `@vectojs/core >=1.38.0 <2`, `@vectojs/ui >=2.19.0 <3`, `@vectojs/markdown >=0.21.1 <1`.

## Usage

```ts
import { Scene } from '@vectojs/core';
import { MarkdownApp } from '@vectojs/markdown-app';

const scene = new Scene(document.querySelector<HTMLCanvasElement>('canvas')!);

const app = new MarkdownApp({
  initialTitle: 'README',
  initialContent: '# Hello\n\nEdit the source and the preview updates.',
  theme: 'githubDark',
  editable: true,
  virtualize: { overscan: 4 },
  onChange: (content) => console.log('document now', content.length, 'chars'),
});
app.setSize(720, 520);
scene.add(app);
```

## Highlights

- Split-brain workbench in one entity: a native-backed `TextArea` source editor on the left, a live
  `Markdown` preview on the right (`source`, `preview`, and `previewScroll` are public fields you
  can reach).
- Browser-native editing stays native through VectoJS's projected input layer: IME composition,
  clipboard, undo, and selection all behave exactly like a DOM textarea.
- Theme picker wired to every `@vectojs/markdown` preset (`githubDark`, `dracula`,
  `solarizedLight`, ...) via `setTheme()`; the list is derived from the markdown package's own
  `PRESET_THEMES`, so presets cannot silently no-op here.
- Toolbar controls out of the box: title display, edit toggle, and theme dropdown; hide the whole
  bar with `showToolbar: false` or flip editing at runtime with `setEditable()`.
- Large documents stay smooth: `virtualize: true | { overscan }` delegates block virtualization to
  the markdown package so only visible top-level blocks exist as entities.
- Application-owned persistence hooks: `onChange(content)`, `onLinkClick(url)`, plus imperative
  `setContent()`, `setTheme()`, and `setTitle()`.
- Deliberately excluded: filesystem persistence, collaboration, WYSIWYG editing, search, and
  HTML/PDF export — applications own their document model.

> Documents @vectojs/markdown-app@0.1.1.

## Documentation

- [Markdown reference](https://vectojs.org/reference/ui-markdown/)
- [TextArea reference](https://vectojs.org/reference/ui-textarea/)
- [ScrollView reference](https://vectojs.org/reference/ui-scrollview/)
