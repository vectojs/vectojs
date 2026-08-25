---
'@vectojs/styles': patch
---

fix(styles): fallback detector tolerates whitespace after `var(` (#753 follow-up)

`HAS_VAR_FALLBACK_RE` required the custom property to start immediately after
the opening paren, so `var( --accent, #fff)` matched none of the three var()
forms and passed through silently unresolved — reaching mapped fields as a
literal string while Canvas2D kept the previous paint, exactly what #645's
guard exists to prevent.

The detector now allows whitespace between `var(` and `--key` (`/var\(\s*--/`),
kept conservative: whitespace only, not the full CSS token grammar.
