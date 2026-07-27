---
'@vectojs/markdown': patch
---

Make a streaming code block ~3x cheaper per chunk.

Two changes, only the second of which mattered:

`CodeBlock` is now reused in place during streaming (via the `setCode()` that
already existed but the reconciler never called), instead of being destroyed and
rebuilt on every chunk. An unclosed fenced block is the second most common shape an
LLM streams, so this looked like the win — **measured, it changed nothing.**

The actual cost was inside `buildLines`, which re-highlighted **every line** on
every call. Streaming appends to the end, so all but the last line are
byte-identical to the previous build; re-tokenizing them made an append O(N) and a
whole stream O(N²). It now reuses the highlight of the unchanged line prefix.

Measured over 300 appends to a growing block: **34.07ms → 11.55ms (2.95x)**,
0.114ms → 0.038ms per append. The lexer's share of the remaining time rose from 7%
to 23%, which is the cross-check that the removed work was real.

The previous last line is deliberately not reused, since a chunk usually lands
mid-line and changes it.
