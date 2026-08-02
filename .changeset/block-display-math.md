---
'@vectojs/markdown': minor
---

Render `$$...$$` as display math, and give every math SVG an explicit colour.

There was no block-level math tokenizer: only an inline `$...$` rule, which
deliberately refuses `$$` so currency ("$5 to $10") is not mistaken for a
formula. With no block rule, marked's text tokenizer consumed the leading `$`,
the inline rule matched the *inner* `$...$` pair, and the outer two dollars
survived as literal text — so `$$x$$` rendered the formula with a stray `$`
painted on each side. A `blockMath` block extension now consumes the whole run,
registered identically in `Markdown.ts` and `MarkdownWorker.ts`.

Separately, MathJax paints glyphs with `fill="currentColor"`, and this package
base64s the SVG into a `data:` URI. A data URI is an isolated document with no
CSS inheritance, so `currentColor` fell back to its initial value — black —
which made every formula invisible against this package's own dark default
theme. The resolved colour is now set on the SVG root, so `currentColor`
resolves inside that document: display math takes `theme.textColor`, and inline
math inherits the colour of the run it sits in, so `$x$` in a heading or
blockquote matches the prose around it. The colour is part of the conversion
cache key, since it is baked into the cached bytes.
