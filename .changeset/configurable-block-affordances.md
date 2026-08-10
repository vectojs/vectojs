---
'@vectojs/markdown': minor
---

Make the code and table affordance controls selectable and their labels
translatable

`blockAffordances: true` was all-or-nothing: it always produced both a copy and
a download control, always labelled in English. Neither is a reasonable fixed
choice. Every control is a focus stop in every code block, so a document with
many fences doubles its tab count for a download nobody asked for, and a
non-English document had no way to relabel a button a screen reader announces
verbatim.

The new `affordances` option takes `copy`, `download`, and a `labels` map.
Defaults reproduce the previous behaviour exactly, so existing pages are
unchanged.

Which controls appear and what they are called are kept as separate axes because
they are separate decisions — one is interaction and accessibility surface, the
other is localization, and they are rarely made by the same person. Success
labels (`copied`, `saved`) are their own strings rather than derived from the
action labels, since no derivation of "copied" from "copy" survives
translation.

`resolveBlockAffordanceConfig()` is exported so a consumer assembling controls
by hand resolves defaults through the same function rather than restating them
and drifting.

Controls are pushed in visual order, which is also DOM and tab order, so the
keyboard and screen-reader sequence matches what is drawn.
