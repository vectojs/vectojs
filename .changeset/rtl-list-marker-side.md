---
"@vectojs/markdown": patch
---

Place RTL Markdown list markers on the reading-start (right) side. `Markdown` always prepended the bullet/number as a leading span, so for a right-to-left item (Arabic, Hebrew) the directionally-neutral marker bidi-reordered to the visual **left** instead of the reading-start **right**. The list now detects each item's base direction (`BidiResolver.getBaseLevel`) and, for RTL items, appends the marker as a trailing span — `" •"` reorders to a visual `"• …"` and `" .N"` to `"N. …"`, both flush-right in reading order. LTR items keep the leading marker exactly as before. Verified on real Chrome 150 (bullet/number on the right for Arabic lists, still on the left for LTR).
