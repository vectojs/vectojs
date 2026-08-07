---
"@vectojs/markdown": minor
---

Support GFM footnotes. `[^1]` renders as a small tinted `[1]` marker and `[^1]: note` as its own block, with `theme.footnoteColor` (derived from `linkColor`) and `theme.footnoteMarkerScale` to control them.

This replaces two wrong renderings rather than filling a gap. Footnote lexing previously split on whether the note body contained a space, because marked's link-reference-definition rule claims the line and a link destination cannot contain one: `[^1]: The note.` rendered the definition as a stray body paragraph and printed `Here[^1] is text.` with its raw syntax, while `[^1]: Note.` turned the reference into a **real clickable link to `Note.`** and dropped the definition from the output entirely.

Definitions are single-line; a marker prints its label as written rather than renumbering, so a reference renders before its definition arrives while streaming. Claiming the definition line ahead of marked's `def` rule also keeps `tokens.links` empty, so a footnoted document no longer permanently degrades incremental lexing.
