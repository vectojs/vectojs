---
"@vectojs/markdown": minor
---

add `incompleteMode` and `onStable` streaming options

`createStream()` accepts `incompleteMode: 'literal' | 'optimistic'`. The default
`'literal'` is unchanged from every prior release: trailing unclosed inline
syntax renders as the plain text `marked` produces for it. `'optimistic'` guesses
that the trailing paragraph's last unclosed strong/emphasis/inline-code construct
will close and renders it with that formatting immediately, hiding the syntax
characters; an unclosed link shows its label as plain, non-clickable text because
no URL is known yet. The guess is display-only, never touches `Markdown.tokens`,
applies only to the document's last paragraph while the stream is open, and is
unwound on `close()` — so a literal and an optimistic stream of the same source
end at an identical document.

`createStream()` also accepts `onStable`, which fires exactly once after a
successful `close()` with a snapshot of the top-level block entities. It is not
fired by `flush()`, `abort()`, or `destroy()`.

`close()` now resolves only after the final chunk's parse has actually been
applied. Previously it could resolve while the last chunk was still being lexed
in the worker, so the rendered document did not yet reflect everything written.
