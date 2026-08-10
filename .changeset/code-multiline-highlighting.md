---
'@vectojs/markdown': minor
---

Carry syntax state across lines, so block comments and multi-line strings
highlight

The tokenizer ran independently per line, which is correct only for languages
whose every construct closes on the line it opens. A JSDoc block was colored on
its `/**` line and then reverted to plain code for every continuation line, and
the keywords inside it (`return`, `class`, `function` in prose) were colored as
live code. CSS was worse: its only comment form is `/* … */`, so the language
declared no line comment at all and CSS comments were never highlighted.

`highlightLine()` now takes and returns a carry state, and `CodeBlock` records
the state entering each line. Block comments (`/* … */`, `<!-- … -->`),
JS/TS template literals, and Python triple-quoted strings now span lines.

The carry is deliberately a single open construct rather than a stack, because
none of these forms nest — a `/*` inside a block comment does not open a second
one, and treating it as a stack would leave the comment unterminated at the
first `*/`.

Single-line quote rules still refuse to carry. That is what keeps a Rust
lifetime (`&'a str`) from opening a string that would otherwise color the rest
of the file, and it is why the multi-line string forms are listed separately per
language instead of being inferred from the quote set.

The incremental streaming path keeps its prefix reuse: the recorded state is the
state _entering_ each line, so an appended chunk resumes from the reuse boundary
by reading one entry rather than rescanning from the top of the block. A
streamed build and a one-shot build of the same source produce identical
segments.
