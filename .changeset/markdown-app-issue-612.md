---
'@vectojs/markdown-app': patch
---

Fix two markdown-app polish defects from the #612 review.

`MarkdownApp.setSize` now marks the scene dirty after relayouting. The child
paths it drives early-return on unchanged geometry (`Markdown.setMaxWidth`)
or never dirty at all (`ScrollView.updateContentSize`), so a height-only
resize left an on-demand `Scene` showing stale pixels. It now dirties like
the sibling setters (`setTheme`, `setTitle`) do.

The hardcoded `THEMES` list is gone: it duplicated the preset union from
`@vectojs/markdown`, so a future preset compiled (the app type aliases
`MarkdownThemePresetName`) but silently no-oped in `setTheme`. The theme list
is now derived from `PRESET_THEMES` — one source of truth, so a preset added
to `@vectojs/markdown` appears in the picker automatically.
