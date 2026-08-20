# @vectojs/markdown-app

Canvas-native Markdown reader and source workbench for VectoJS.

`MarkdownApp` composes `@vectojs/markdown` with `TextArea`, `ScrollView`,
`Dropdown`, `Toggle`, and `Stack`. It is a standalone package and does not
depend on `@vectojs/desktop`.

```ts
import { MarkdownApp } from '@vectojs/markdown-app';

const app = new MarkdownApp({
  initialTitle: 'README',
  initialContent: '# Hello\n\nEdit the source and the preview updates.',
  theme: 'githubDark',
});

scene.add(app);
```

Without `initialContent`, the workbench starts with an editable `# Untitled`
document.

The source editor is backed by VectoJS's projected native `TextArea`, so IME,
clipboard, undo, and selection remain browser-native. The preview delegates
parsing, TeX, code blocks, selectable content, and large-document virtualization
to `@vectojs/markdown`.

## Scope

This package is a focused reader/workbench shell. It intentionally does not
include filesystem persistence, collaboration, WYSIWYG editing, search, or
HTML/PDF export. Applications own document persistence and can use
`setContent()` and `onChange` to connect their own model.
