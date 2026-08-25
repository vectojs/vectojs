---
'@vectojs/markdown': patch
---

Restore `Markdown.setTheme(theme)` — the sanctioned re-theme path behind the read-only `theme` getter.

#776 exposed `theme` as a getter to close #657's silent-assignment trap but shipped no replacement API, so consumers that legitimately re-theme (markdown-app's settings picker) had nowhere to go and the monorepo build broke. `setTheme` accepts the same shapes as the constructor's `theme` option (preset name or full/partial theme object), resolves presets through `resolvePresetTheme`, carries `blockGap` onto the content Stack, and rebuilds through `setContent` so an active stream tears down safely — the same end state as fresh construction.
