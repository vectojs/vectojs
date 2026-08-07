---
"@vectojs/layout": minor
---

Add `InlineObject.key`, so an object span's memo cannot serve the wrong painter.

`prepareRich` memoizes prepared paragraphs and its object fingerprint was
`width,height,depth,alt`. `paint` is deliberately excluded — a fresh closure per
call never compares equal and would defeat the memo entirely — which is safe only
when the drawing is a function of `alt`. Inline math qualifies: its data URI is a
pure function of the TeX source it also announces. An image does not: its picture
is chosen by its URL while `alt` is human prose, so two badges sharing alt text
and differing in URL produced a memo hit and the second painted the first's image.

`key` identifies what an object paints when `alt` does not. It is part of both the
paragraph memo key and `objectRangeEquals`, which gates the streaming
strict-extension path — the kept prefix words hold the `InlineObject` they were
shaped with, so a stale painter would otherwise survive into an extended
paragraph. Both sites are independently guarded and independently tested.

Optional and additive: an object that sets no `key` behaves exactly as before.
