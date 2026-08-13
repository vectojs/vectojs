---
'@vectojs/markdown': patch
---

Fix two late-arrival rebuild gaps. An inline image nested in a blockquote, a `:::` container or a list item never re-measured after its decode: `inlineImageBoxesStale` only walked top-level `heading`/`table` tokens, so a nested heading's badge kept the square box it reserved before knowing its aspect ratio — the walk now recurses through the same three nesting shapes `containsImage` uses. And a late `*[TERM]:` definition did not retroactively style prose in a single-block document: the `abbreviationsChanged` cap forced `matchLen` to 0, and for one token `0 === oldTokens.length - 1` satisfied the in-place condition with the new dictionary already installed, so only the tail child was restyled — the in-place branches are now gated on `!abbreviationsChanged`.
