---
'@vectojs/markdown': minor
---

Markdown backlog sweep (#657): dead module removal, doc fixes, streaming-stat cost.

- Deleted `markdown-typography.ts`, a dead duplicate of the live `applyTypography` that had zero importers and had diverged from it in both directions. The live typographer now performs the one substitution the theme documentation already promised but the shipped code lacked: `+-` → `±`.
- Removed the dead `hasAbbrDef()` opener detector from `markdown-abbr.ts`. Unlike its container/footnote siblings it had no caller: an abbreviation definition is strictly single-line, so incremental lexing needs no cheap-reject guard for it.
- Moved seven orphaned JSDoc blocks back onto the methods they document (`Markdown.ts`, `markdown-image.ts`); after earlier method extractions the comments had been left stacked above a neighbouring symbol's doc.
- `streamStats.stablePrefixChars` is now reported by the worker's lex straight from `IncrementalLexCache.stableOffset` instead of being re-summed over the matched token prefix on every response, which made a stream of n chunks quadratic in that one stat.
- `Markdown.theme` is now `readonly`. Entities capture colors, fonts and sizes at build time, so assigning the field after construction painted part of the document in each palette; pass the palette at construction instead.
