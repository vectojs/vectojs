# @vectojs/markdown

Canvas-native Markdown (with TeX math) rendering for [VectoJS](https://github.com/vectojs/vectojs).

`Markdown` is a high-level entity that parses Markdown with
[`marked`](https://marked.js.org/), renders TeX math to SVG with
[MathJax](https://www.mathjax.org/), and lays the result out using
`@vectojs/ui` components (`RichText`, `Stack`, `Table`, `Text`, `Image`). It also
exports `CodeBlock`.

This package was split out of `@vectojs/ui` so that the heavy `marked` +
`mathjax-full` dependencies are only pulled in by apps that actually render
Markdown. Because it depends on `@vectojs/ui` components, it sits **above** `ui`
in the dependency graph — install it alongside `@vectojs/ui` and `@vectojs/core`.

## Install

```sh
bun add @vectojs/markdown @vectojs/ui @vectojs/core
```

## Usage

```ts
import { Markdown, CodeBlock } from '@vectojs/markdown';

const md = new Markdown({ source: '# Hello\n\nInline math $E = mc^2$.' });
scene.add(md);
```

> Migrating from `@vectojs/ui` ≤ 1.x? `Markdown` and `CodeBlock` used to be
> exported from `@vectojs/ui`. As of `@vectojs/ui@2.0.0` they live here — change
> `import { Markdown } from '@vectojs/ui'` to `from '@vectojs/markdown'`.
