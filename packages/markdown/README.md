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
import { Markdown } from "@vectojs/markdown";

const md = new Markdown("# Hello\n\nInline math $E = mc^2$.");
scene.add(md);
```

## Streaming

`createStream()` coalesces accepted chunks into at most one Markdown
parse/layout commit per animation frame. `write()` applies backpressure when its
bounded buffer is full; await it when consuming an async token source.

```ts
const md = new Markdown("");
scene.add(md);

const stream = md.createStream();
for await (const token of tokens) {
  await stream.write(token);
}
// Commits the final text, then waits for the parse to be applied — once this
// resolves, the rendered document reflects everything written.
await stream.close();
```

Add fixed-rate typewriter pacing without changing producer code:

```ts
const stream = md.createStream({
  pacing: { graphemesPerSecond: 48 },
  maxBufferedChars: 64 * 1024,
  signal: abortController.signal,
});
```

Pacing slices by grapheme cluster, so combining marks, emoji ZWJ sequences,
flags, and surrogate pairs stay intact across ordinary chunk/frame boundaries.
`abort()` discards uncommitted text; `Markdown.destroy()` does the same cleanup
automatically. The existing `appendMarkdown()` API remains synchronous and
flushes submitted controller text before a direct append.

### Incomplete Markdown while streaming

Mid-stream, the trailing text of a paragraph is often an unclosed inline
construct — `**bo`, `` `cod ``, `[text](url`. `marked` has no signal that more
characters are coming, so it lexes those as plain text. `incompleteMode` chooses
what you show in the meantime:

```ts
const stream = md.createStream({ incompleteMode: "optimistic" });
```

| Mode                  | Unclosed `**bo` renders as           |
| --------------------- | ------------------------------------ |
| `'literal'` (default) | `**bo` — the literal characters      |
| `'optimistic'`        | **bo** — guessed bold, syntax hidden |

`'optimistic'` covers strong, emphasis, and inline code. An unclosed link shows
its label as plain text: with no closing `)` there is no URL yet, so nothing is
made clickable. Only the document's **last paragraph** is ever guessed at, and
only while the stream is open — headings, list items, table cells, and any
earlier paragraph are always literal.

The guess is display-only. `Markdown.tokens` is never affected, and `close()`
unwinds it, so a `'literal'` and an `'optimistic'` stream of the same source end
at an identical document. `'literal'` remains the default: it is what every prior
release rendered.

### Knowing when the document is final

`onStable` fires once, after `close()` has committed the last chunk _and_ the
parse has been applied. Use it for one-time work you do not want repeated against
content still in flight:

```ts
const stream = md.createStream({
  onStable: (blocks) => {
    for (const block of blocks) fadeIn(block);
  },
});
```

It never fires on `flush()`, `abort()`, or `destroy()` — none of those mean the
content stopped changing. It receives a snapshot array, not a live reference.
Calling `appendMarkdown()` or `setContent()` from inside the callback throws; a
throw from the callback rejects the `close()` promise. `onStable` is independent
of `incompleteMode` and works with the `'literal'` default.

> Migrating from `@vectojs/ui` ≤ 1.x? `Markdown` and `CodeBlock` used to be
> exported from `@vectojs/ui`. As of `@vectojs/ui@2.0.0` they live here — change
> `import { Markdown } from '@vectojs/ui'` to `from '@vectojs/markdown'`.
