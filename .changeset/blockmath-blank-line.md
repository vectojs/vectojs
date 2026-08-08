---
'@vectojs/markdown': minor
---

Stop the `blockMath` tokenizer at a blank line

**Behaviour change**: a `$$` display-math block now ends at the first blank
line. Previously its content pattern crossed blank lines, so an unterminated
`$$` reached arbitrarily far ahead and could absorb the rest of the document
once a later `$$` arrived.

**Before**: `$$\nx = 1\n\ny = 2\n$$\n` was one `blockMath` token whose body
(`x = 1\n\ny = 2`) is not valid TeX.

**After**: the same source is an unclosed fence (rendered as a `CodeBlock`
showing the TeX source), then a `y = 2` paragraph, then a `$$` paragraph.

**Migration**: multi-line math without blank lines is unaffected, which covers
`aligned`, `cases`, `matrix` and every other multi-line environment:

```markdown
$$
\begin{aligned}
a &= b \\
c &= d
\end{aligned}
$$
```

**Scope, stated precisely**: this removes the tokenizer's unbounded forward
reach, which is a correctness and blast-radius fix. On its own it did **not**
make math documents lex incrementally, because `incrementalLex` also guarded a
_backward_ reach through marked's `startBlock` paragraph clip. That remaining
half is done in
[`incremental-lex-blockmath-gate`](./incremental-lex-blockmath-gate.md), which
narrows the gate and carries the streaming measurement; the forward guard here
was also widened there from `(?!\n\n)` to `(?!\n[ \t]*\n)`, since a
whitespace-only line is a blank line to marked but was not to this lookahead.
