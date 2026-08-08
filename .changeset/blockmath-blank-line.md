---
'@vectojs/markdown': minor
---

Stop blockMath tokenizer at blank lines for incremental lexing

**Breaking change**: Math blocks now terminate at the first blank line, treating the remainder as separate paragraphs. This improves streaming performance for math-heavy documents from 1.0145x (parity) to ~69.8x (like prose).

**Before**:
```markdown
$$
x = 1

y = 2
$$
```
Rendered as one continuous math block (but invalid TeX).

**After**:
```markdown
$$
x = 1

y = 2
$$
```
Renders as:
1. An unclosed math fence `$$\nx = 1\n` (CodeBlock showing TeX source)
2. A paragraph `y = 2`
3. A paragraph `$$`

**Migration**: Multi-line math blocks without blank lines continue to work unchanged:
```markdown
$$
\begin{aligned}
a &= b \\
c &= d
\end{aligned}
$$
```

This change enables incremental lexing for math documents, where each closed block is tokenized independently rather than forcing a whole-document scan.
