---
"@vectojs/markdown": patch
---

Stream math documents incrementally instead of degrading to whole-document lexing

A line-start `$$` no longer forces `incrementalLex` to re-lex the entire
accumulated source on every chunk. The `'block-math'` degrade reason is now
unreachable, so a streamed document containing display math keeps a stable
block boundary exactly like prose.

Measured on real headed browsers via `benchmarks/run-browsers.sh`
(`markdown-stream-math`, Chrome 240.04 Hz / Firefox 239.56 Hz), streaming a
26 760-char document of 200 heading/prose/formula sections in 32-char chunks
against an in-process control that re-lexes the whole accumulated source per
chunk (what a degraded instance does):

| engine  | before   | after   | speedup    | math/prose ratio |
| ------- | -------- | ------- | ---------- | ---------------- |
| Chrome  | 501.6 ms | 3.60 ms | **139.3x** | 0.984            |
| Firefox | 577.0 ms | 5.98 ms | **96.5x**  | 0.874            |

The mechanism, from `incrementalLex`'s own counters rather than the clock:
characters fed to `marked.lexer()` fall **215.9x** (11 222 472 to 51 983), the
largest single chunk lexes **105** characters at every document size tested
(25/50/100/200 sections) where the control grows to the full 26 760, and the
boundary settles at **99.84%** of the document. The `math/prose ratio` column is
the parity claim: an identical document with formulas replaced by paragraphs of
comparable length costs the same, so math is no longer a special case. Deep
token-tree equality against a whole-document lex is asserted before any timing
is taken.

This completes the work
[`blockmath-blank-line`](./blockmath-blank-line.md) started. That changeset
closed the tokenizer's _forward_ reach; two things remained.

**The backward reach, narrowed rather than accepted.** marked's `blockTokens`
clips the text handed to the paragraph tokenizer whenever an extension's
`startBlock` hook reports a position, and merges the next paragraph into the
clipped one. `blockMath` supplies `start()`, so a `$$` ahead can re-group
paragraphs already emitted — which is why the gate degraded outright. Measured
against marked 18.0.7, the merge additionally requires `tokens.at(-1)?.type ===
'paragraph'`, so it can only rewrite **two adjacent `paragraph` tokens**; any
token between them, a `space` or a `heading`, blocks it. A stable cut always
lands immediately after a `space` token, so such a pair can never straddle a
boundary. The blanket source scan is therefore replaced by a cut ceiling that
keeps an adjacent pair out of the stable prefix, and the condition is transient:
once the `$$` arrives and the pair merges, the boundary advances.

**A hole in the forward guard.** The previous lookahead was `(?!\n\n)`, which is
not marked's own notion of a blank line (`/^[ \t]*$/` per line). Measured:
`'$$\nx\n   \n$$\n'` was still ONE `blockMath` token spanning the
whitespace-only line, while marked pushes a real `space` token for that line —
so a cut could be placed there and then swallowed when the closing `$$`
arrived. The guard is now `(?!\n[ \t]*\n)` in both registration sites.

**Behaviour change, extending `blockmath-blank-line`'s**: a whitespace-only line
now terminates `$$` just as a bare blank line does. `'$$\nx\n   \n$$\n'` is a
paragraph run rather than one formula. Multi-line math without blank lines is
unaffected, so `aligned`, `cases` and `matrix` still work.

**Also fixed**: `MarkdownWorker.ts` carried the pre-`blockmath-blank-line`
tokenizer (`[\s\S]+?`, no blank-line guard) while `Markdown.ts` carried the
guarded one. Both register `blockMath` on the shared `marked` singleton, so the
effective rule depended on module import order. The two are now identical.
