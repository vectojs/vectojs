---
'@vectojs/markdown': minor
---

Add per-kind affordance config and an optional code-block border color:

- `BlockAffordanceConfig` gains `code` / `table` overrides so a document can
  disable copy/download controls for tables without affecting code blocks (a
  table that already offers copy in its own UI no longer needs two overlapping
  controls). An omitted per-kind key inherits the top-level `copy`/`download`.
- `MarkdownTheme` gains `codeBorderColor` (optional; unset keeps the previous
  no-border rendering). Code blocks can now outline themselves against light
  page backgrounds.
