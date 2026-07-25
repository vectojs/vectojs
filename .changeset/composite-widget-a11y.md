---
"@vectojs/ui": patch
---

Give `RadioGroup` and `Tabs` real per-child ARIA semantics and keyboard operation (WCAG 4.1.2 / 2.1.1). Both previously exposed only a container role (`radiogroup` / `tablist`) with no child roles and no keyboard support, so a screen reader announced an empty container and keyboard users couldn't operate them. Each now projects one transparent, focusable hotspot per child (reusing the `RichText` link-hotspot pattern): `RadioGroup` emits `role="radio"` with `aria-checked` and a roving `tabindex`; `Tabs` emits `role="tab"` with `aria-selected` and a roving `tabindex`. Keyboard: arrow keys move and activate within the group (RadioGroup skips disabled options and wraps, Space selects the focused one; Tabs supports Left/Right/Up/Down plus Home/End, wrapping), routed through the same `change` path as pointer selection so existing `onChange` handlers are unaffected. Tree, Table, and ContextMenu remain follow-ups.
