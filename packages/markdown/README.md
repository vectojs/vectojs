# @vectojs/markdown

`@vectojs/markdown` renders Markdown (with TeX math) as a canvas-native entity tree: the
`Markdown` entity parses with `marked`, typesets math through `@vectojs/tex`, and lays the result
out using `@vectojs/ui` components. It was split out of `@vectojs/ui` precisely so the heavy
`marked` + `@vectojs/tex` dependencies load only for apps that render documents — it sits **above**
`ui` in the dependency graph and takes `@vectojs/core` and `@vectojs/ui` as peer dependencies.

## Install

```bash
bun add @vectojs/markdown @vectojs/ui @vectojs/core
```

Peers: `@vectojs/core >=1.34.0 <2`, `@vectojs/ui >=2.6.0 <3`.

## Usage

```ts
import { Scene } from '@vectojs/core';
import { Markdown } from '@vectojs/markdown';

const scene = new Scene(document.querySelector<HTMLCanvasElement>('canvas')!);
scene.renderMode = 'onDemand';

const md = new Markdown('# Hello\n\nInline math $E = mc^2$.', {
  maxWidth: 640,
  theme: 'githubDark', // or a full MarkdownTheme object
  onLinkClick(href) {
    console.log('navigate', href);
  },
});
scene.add(md.setPosition(24, 24));

// Stream LLM output: chunks coalesce into one parse per frame.
const stream = md.createStream({ incompleteMode: 'optimistic' });
stream.write('# Ti');
await stream.close(); // resolves after the final parse is applied
```

## Highlights

- CommonMark plus GFM tables, strikethrough, task lists, and autolinks; paragraphs become
  `RichText`, fences become `CodeBlock`, GFM tables become `Table`.
- Frame-coalesced streaming via `createStream()`: at most one parse/layout commit per animation
  frame, grapheme-cluster-safe typewriter pacing (`graphemesPerSecond`), bounded-buffer
  backpressure on `write()`, `onStable` firing once when the document is final, and an
  `incompleteMode` of `'literal'` (default) or `'optimistic'` for unclosed markers mid-stream.
- TeX math through `@vectojs/tex`, dynamically imported on the first formula so prose-only bundles
  stay small; `preloadMathJax()` / `isMathJaxReady()` control the lazy load, converted formulas are
  cached process-wide, and fenced math blocks typeset only once their closing fence arrives.
- Themes: constructor accepts a preset name (`'githubDark' | 'githubLight' | 'dracula' |
'solarizedDark' | 'solarizedLight'`) or a full theme object; post-construction changes go through
  `setTheme()` — `theme` itself is getter-only (#657).
- Selectable content: rendered text projects browser-native drag selection, copy, and find-in-page;
  toggle at runtime with `setSelectable(false)`.
- Block affordances: opt-in copy/download controls on code blocks and tables with injectable
  `writeClipboard` / `saveFile`, per-kind overrides, and CSV export helpers (`tableToCsv`,
  `tableToMarkdown`).
- Front matter: `scanFrontMatter` / `parseFrontMatterFields` expose YAML-ish metadata before the
  document body renders.
- Large-document virtualization: pass `virtualize` and drive `setVisibleRange(scrollY, viewportHeight)`
  to materialize only top-level blocks near the viewport.

## Images — `imageResolver` & CapGlyph adapter

`Markdown` maps every `![](src)` through a single injectable resolver. The
package has no CapGlyph import — that adapter lives in the app layer.

```ts
import type { ImageSource } from '@vectojs/ui';
import type { MarkdownImageResolver } from '@vectojs/markdown';

type MarkdownImageResolver = (src: string) => ImageSource | Promise<ImageSource>;
const defaultMarkdownImageResolver: MarkdownImageResolver = (src) => ({
  kind: 'url',
  url: src,
});
```

`MarkdownOptions.imageResolver` drives both block `Image` entities and inline
`InlineObject` rasters (`blob` → `createImageBitmap` → `ImageBitmap`, with
object-URL fallback). Sync and async resolvers both work; `paragraphImage` keeps
a guessed 800×480 box until the resolver settles or the raster decodes, then
reflows and `scene.markDirty()`.

**CapGlyph adapter (app layer):**

```ts
import type { MarkdownImageResolver } from '@vectojs/markdown';

const imageResolver: MarkdownImageResolver = async (src) => {
  if (!src.startsWith('capglyph:')) return { kind: 'url', url: src };
  const cap = parseCapGlyph(src); // { endpoint, token, variant }
  const res = await fetch(cap.endpoint, {
    headers: { Authorization: `Bearer ${cap.token}` },
  });
  if (!res.ok) throw new Error(`CapGlyph fetch failed: ${res.status}`);
  const blob = await res.blob();
  const bitmap = await createImageBitmap(blob);
  return { kind: 'bitmap', bitmap }; // caller-owned; no blob: URL in a11y
};

const md = new Markdown(source, { maxWidth: 640, imageResolver });
```

Trust: **Master never enters client** — the resolver fetches only Derived
Raster bytes (watermarked, capped size); CapGlyph is the credential/provenance
signal, not a resize service. `auto` semanticMode keeps `blob`/`bitmap` off the
shadow `<img src>`; Visual Flattening already removes the canvas hit-target and
context-menu, so `role` is only needed when even a `url` must not appear in the
a11y tree. See the [Image reference](https://vectojs.org/reference/ui-image/)
for the full Visual Flattening trust table and `DecodedImage` lifecycle.

> Documents @vectojs/markdown@0.23.0.

## Documentation

- [Markdown reference](https://vectojs.org/reference/ui-markdown/)
- [CodeBlock reference](https://vectojs.org/reference/ui-codeblock/)
- [Streaming guide](https://vectojs.org/learn/streaming/)
