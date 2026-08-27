---
"@vectojs/markdown": patch
---

fix(markdown): render inline $$...$$ inside paragraphs (StackEdit compat)

Inline with $$ previously produced no math span, while display block
$$...$$ on standalone lines already worked. Extend the inlineMath
tokenizer to accept both $...$ and $$...$$ (strip outer dollars) and
update start() to detect $$. Block $$ remains display math (line-start
without trailing prose); empty $$ and currency guards unchanged.
