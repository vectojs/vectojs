---
'@vectojs/markdown': minor
---

Highlight far more code fences, and stop gating the whole tokenizer on the
keyword table.

`highlightLine()` used to return the line as one plain segment whenever the
language had no keyword set, so an unknown language lost its comments, strings
and numbers as well — the whole tokenizer sat behind that lookup. The comment
prefix was hardcoded too (`//` for every language, `#` only for Python and Rust),
so a shell script's `#` comments were never colored even where the keyword lookup
succeeded. A shell-heavy document rendered entirely in one color.

Lexical syntax is now described per language and consulted independently of the
keyword table, so a language can have keywords, syntax, or only one of the two
and still be highlighted. Added keyword sets for `bash`, `json`, `css` and
`html`; lexical syntax for `yaml`, `toml`, `ini`, `dockerfile`, `makefile`,
`jsonc`, `json5`, `scss`, `sass`, `less`, `glsl`, `c`, `cpp`, `go`, `java`,
`kotlin` and `swift`; and dialect mapping so `jsx`/`tsx`/`mjs`/`cjs`/`mts`/`cts`
resolve onto their base language, `sh`/`zsh`/`shell`/`console` onto `bash`, and
`vue`/`svelte`/`xml`/`svg` onto `html`.

The fence info string is also normalized now: it was written verbatim, so
` ```Bash ` resolved to nothing, and fence attributes (` ```ts title="a.ts" `)
prevented a match.

New `highlightedLanguages()` reports what this build can highlight.

Per-language lexical differences are respected rather than flattened: `//` is not
a comment in shell or strict JSON, `'` does not open a string in JSON, CSS claims
no line comment because a line-based tokenizer cannot span its block comments,
and numbers are left uncolored in markup where they are attribute noise.
