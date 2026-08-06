---
"@vectojs/markdown": minor
---

Centralize Markdown theme tokens: hoist every hardcoded color, font size and
spacing value into `MarkdownTheme`.

`MarkdownTheme` gains 18 keys covering the values that were previously literals
at their use sites: `linkColor` (which had five separate copies),
`mathFallbackColor`, the four `syntax*Color` keys (previously function-local
constants inside the highlighter, unreachable from outside), `headingSizes`,
`codeFontSize`, `tableFontSize`, `codeLineHeight`, `bodyLineHeight`, and the
spacing set `blockGap`, `codePadding`, `codeRadius`, `listGap`, `listItemGap`,
`quoteIndent`, `quoteInnerGap`, `quoteBorderWidth`, `imageRadius`.

Two keys are derived rather than fixed, so overriding one value no longer
silently desynchronizes another:

- `tableFontSize` defaults to `fontSize - 2`, so raising only `fontSize` still
  scales tables.
- `quoteTextColor` defaults to `textColor`. It was declared and defaulted but
  **never read** — blockquote text was not themeable at all despite the key
  existing. It is now applied.

`CodeBlock`'s constructor accepts a partial `MarkdownTheme` and resolves it
against the defaults. It previously required a fully-populated theme, so a
caller passing a hand-built literal written against the old 12-key shape would
throw `lineHeight must be a positive finite number` once size keys became
theme-driven. No existing caller needs to change.
