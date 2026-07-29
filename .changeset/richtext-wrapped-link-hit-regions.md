---
"@vectojs/ui": patch
---

`RichText`: make wrapped links clickable on every visual line.

A link now keeps one native semantic anchor while pooling a presentational pointer
region for each wrapped line. Canvas and browser clicks both activate the link from
continuation lines, and the empty tail beside a shorter line no longer activates it.
