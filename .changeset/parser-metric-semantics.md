---
"@vectojs/markdown": minor
"@vectojs/devtools": minor
---

Rename the Markdown streaming reuse metrics to describe what they measure, and
report the parser cost that was missing.

`marked` has no incremental lexing API, so `MarkdownWorker` calls
`marked.lexer()` on the **whole accumulated source** for every streamed chunk —
its own comment says so — and `matchLen` is a raw-string comparison against the
caller's prior token raws. The counters built on those two values were named as
though a high match rate meant less lexing:

| before          | after                   | what it actually counts                                                    |
| --------------- | ----------------------- | -------------------------------------------------------------------------- |
| `tokensReused`  | `tokensPrefixMatched`   | leading tokens whose `raw` was unchanged, so their entities were kept      |
| `tokensRelexed` | `tokensReturned`        | tokens in the changed suffix the worker cloned back — the transfer payload |
| `reuseRatio`    | `tokenPrefixReuseRatio` | `matched / (matched + returned)`                                           |

A reader optimising against the old names would keep attacking the transfer path,
which PRs #263 and #264 already reduced by 89×. The lexer, meanwhile, was
invisible.

So this also **adds** the figures that were missing, rather than only renaming:
the worker now times its own `marked.lexer()` call and reports `lexerMs` and
`sourceCharsLexed`, surfaced as a new "Parser cost" group in the `Markdown`
devtools descriptor and a `lexer` row in `formatMarkdownStream`.
`sourceCharsLexed` grows ~O(n²) across a stream of n chunks, which is the shape
the old metrics obscured.

`MarkdownStreamInfo` gains `lexerMs` and `sourceCharsLexed` alongside the three
renamed fields. The old names are not kept as aliases: the defect is that they
mislead, and keeping them would preserve exactly that. Anything reading them from
`inspectMarkdownStream`, the descriptor labels, or the `low-token-reuse` finding's
message needs the new names.

Nine docstrings and audit messages across both packages claimed the changed tail
was "re-lexed" — including `tailFraction`'s, which described it as "fraction of the
document re-lexed" when that fraction is always 1.0. They now say "changed".
