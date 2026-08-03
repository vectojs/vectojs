---
"@vectojs/markdown": patch
---

Lex from the last stable block boundary instead of re-lexing the whole document
on every streamed chunk.

`marked` has no incremental lexing API, so the streaming path re-lexed the entire
accumulated source per chunk, making a stream O(n²). `incrementalLex` now tracks
the last **stable block boundary** — a blank line that appended text can no longer
reach across — and lexes only the text after it, splicing the result onto the
already-stable token prefix.

Measured in `comparisons/stream-markdown-smd` on real Chrome 150 / Firefox 153,
COOP+COEP isolated, median of 9 after 3 warmups, 32-char chunks. A 200-section
document (25 070 chars, 784 chunks):

|                  | before    | after           |
| ---------------- | --------- | --------------- |
| Chrome 150       | 419.6 ms  | 6.02 ms (69.8x) |
| Firefox 153      | 440.2 ms  | 9.06 ms (48.6x) |
| scaling exponent | 1.98      | 0.94 / 1.21     |
| characters lexed | 9 847 040 | 63 806 (154x)   |

The exponent is the substance: the streaming path is now linear rather than
quadratic, so the improvement grows with document length (7.8x at 25 sections,
69.8x at 200).

Token output is unchanged. The contract is that a streamed lex is deeply identical
to `marked.lexer()` of the same source at every intermediate length, enforced by a
differential suite that streams a corpus one character at a time plus a seeded
fuzzer over randomly assembled documents and chunkings.

Two document shapes keep the previous cost by design, because appended text can
retroactively change tokens already emitted: those containing a **link reference
definition** (`marked` resolves reference links across the whole document after
block-lexing) and those containing **display math** (`$$`, whose tokenizer spans
blank lines and whose `start()` hook re-groups preceding paragraphs). Both degrade
to whole-document lexing, which is correct and no slower than before.
