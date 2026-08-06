# @vectojs/markdown

Canvas-native Markdown (with TeX math) rendering for [VectoJS](https://github.com/vectojs/vectojs).

`Markdown` is a high-level entity that parses Markdown with
[`marked`](https://marked.js.org/), renders TeX math to SVG with
`@vectojs/tex`, and lays the result out using `@vectojs/ui` components
(`RichText`, `Stack`, `Table`, `Text`, `Image`). It also exports `CodeBlock`.

This package was split out of `@vectojs/ui` so that the heavy `marked` +
`@vectojs/tex` dependencies are only pulled in by apps that actually render
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

### Streamed TeX math

A fenced math block is typeset only once its closing fence arrives:

````md
```math
\int_0^1 x\,dx = \frac{1}{2}
```
````

While the fence is still open the block renders as an ordinary code block showing
the TeX source, then becomes the formula on the chunk that closes it. This is
deliberate. `marked` lexes an unterminated fence as a _complete_ token as soon as
it reads the info string, so a formula streamed a few characters at a time
arrives as a long run of whole tokens, nearly all of them invalid TeX — typesetting
each one spends the most expensive call in this package rendering an error glyph
that is replaced by the next chunk. Showing the source is both cheaper and more
honest: the formula genuinely is not finished.

Converted formulas are cached (bounded, process-wide), so a repeated formula is
converted once no matter how many documents or instances render it.

Inline `$...$` math is a separate path: it is currently shown as styled source
text, not typeset.

#### The math engine is loaded on demand

TeX math is typeset by `@vectojs/tex`, which is imported dynamically the first
time a document actually has a formula. It is by far the heaviest thing this
package can pull in — measured against a browser bundle of a consumer that renders
only prose, built with code splitting and minification:

| prose-only consumer    |       raw |    gzip | chunks |
| ---------------------- | --------: | ------: | -----: |
| `mathjax-full`         | 2,199,869 | 748,713 |     19 |
| `@vectojs/tex` (now)   |   758,249 | 273,754 |      3 |
| no math at all (floor) |   379,224 | 118,670 |      3 |

Against that floor the math path itself is 630,043 gzip under `mathjax-full` and
155,033 under `@vectojs/tex` — **4.06x smaller**. The eagerly-downloaded entry
chunk a prose-only consumer actually pays for is 117,889 gzip, within 1 KB of the
no-math floor.

Your bundler needs code splitting enabled to see this; without it the bytes are
still in the output, just not evaluated until first use.

The tradeoff is that **the first formula on a page cannot be typeset
synchronously.** It renders as a code block of TeX source — the same state an
unclosed fence already shows — and is replaced once the module resolves. Every
formula after that is synchronous again. (The engine itself is synchronous; the
lazy import is what defers it, and it is kept for the bundle size above.)

While streaming this is invisible: the load starts as soon as an _opening_ math
fence appears, several chunks before the closing one, so the formula is typeset on
the chunk that closes it. `await stream.close()` and `onStable` also wait for a
pending load, so a "final" document never hands you an untypeset formula.

If you need the very first formula typeset in the same tick — measuring layout
immediately after construction, for instance — preload it:

````ts
import { Markdown, preloadMathJax } from "@vectojs/markdown";

await preloadMathJax();
const md = new Markdown("```math\n\\int_0^1 x\\,dx\n```"); // typeset synchronously
````

`preloadMathJax()` is idempotent and shared across every document, so calling it
from several places starts one load. `isMathJaxReady()` reports whether formulas
currently typeset without waiting. If the load fails, formulas keep rendering as
TeX source rather than throwing.

Both names are historical: they date from when `mathjax-full` was the engine and
mean "the math engine", whichever one that is. They keep those names because they
are public API and a rename would break every consumer for cosmetics.

A formula containing a symbol outside the engine's shipped glyph corpus also
renders as TeX source rather than being drawn with that symbol missing.

## Images

An image renders in one of two ways, decided by where it is written.

**On its own, or in a paragraph, blockquote or list item**, the paragraph splits
into blocks and the image becomes an `Image` entity at its natural size, capped
to the available width. This is the ordinary `![alt](url)` case.

**On a line it shares with text** — in a heading, or in a table cell — it renders
as an inline box in the text run, so the prose flows around it and selection and
the accessible name still work. Its height is a multiple of the run's font size
(`theme.inlineImageScale`, default `1.15`) and its width follows the image's
natural aspect ratio, so a badge stays wide and a square icon stays square:

```ts
const md = new Markdown("# Build ![passing](https://img.example/badge.svg)");
```

This is a deliberate departure from HTML, which would render an inline image at
its intrinsic size. A 512px logo written into an `h1` would otherwise tower over
its own heading, and an inline box has to be sized before the image has decoded.
The height is fixed up front for the same reason: the line box never moves, and
only the width settles once the aspect ratio is known.

The `alt` text is the accessible name and the copied text — never painted as
visible prose. If the image fails to load, the box is replaced by the alt text
rather than left as an invisible gap.

## Syntax coverage

Everything in [CommonMark](https://spec.commonmark.org/) plus the
[GFM](https://github.github.com/gfm/) extensions this renderer draws: tables,
strikethrough, task lists, autolinks, plus `$…$` / `$$…$$` TeX math and
` ```math ` fences.

Two constructs are deliberately **not** supported, and both are pinned by tests
so the behaviour cannot drift silently:

- **Definition lists.** `Term` then `: definition` renders as the two literal
  lines the source contains, colon included.
- **Raw HTML blocks.** `<details>`, `<div>`, `<iframe>` and HTML comments render
  nothing at all.

Definition lists are neither CommonMark nor GFM; when they arrive it will be
through the same syntax-extension mechanism footnotes need. Raw HTML blocks
cannot work in a zero-DOM renderer — there is no DOM to hand markup to. `<svg>`
is the one exception, because a self-contained SVG document can be rasterized.

Footnotes (`[^1]`) are **not yet parsed** and currently render as literal source.

> Migrating from `@vectojs/ui` ≤ 1.x? `Markdown` and `CodeBlock` used to be
> exported from `@vectojs/ui`. As of `@vectojs/ui@2.0.0` they live here — change
> `import { Markdown } from '@vectojs/ui'` to `from '@vectojs/markdown'`.
