---
"@vectojs/markdown": patch
---

Stop rendering `H~2~O` with a strikethrough through the `2`.

`marked`'s GFM tokenizer emits a `del` token for a **single**-tilde run as well as
for the double-tilde strikethrough it is meant for, and `collectSpans`' `del` arm
applied `lineThrough` to both. So a reader of `H~2~O` saw H2̶O, with no way to tell
that subscript had been intended.

This was categorically worse than the constructs this renderer simply does not
support. Those fall back to visible literal source, which a reader can interpret;
this one silently changed meaning. A single-tilde run now re-emits its `~`
delimiters as literal characters and renders its content unstruck, so the source
round-trips and inner markup still renders — `~*em*~` keeps its emphasis.

It is **not** subscript. `TextStyle` has no baseline-shift field, so a lowered run
is not expressible today; this makes the rendering honest rather than complete.

`~~x~~` is unaffected and keeps striking, including a single-tilde run nested
inside one (`~~a ~b~ c~~` strikes throughout) — the arm suppresses its own
striking, not inherited striking. `raw` is what distinguishes the two forms, since
the token type and `text` are identical.
