---
'@vectojs/core': minor
'@vectojs/ui': minor
---

Preserve logical source text and native selection geometry across positioned multiline content projections. Visual line separators now belong to their preceding line instead of creating root-origin selection fragments; Text and RichText keep soft wraps, hard breaks, CJK, ligatures, and RTL source order intact; CodeBlock uses a platform monospace-first fallback. Chromium and Firefox browser coverage now includes keyboard copy/paste, Noto Serif substitution, forced colors, DPR and zoom variants, Markdown lists and tables, and standalone Table cells.
