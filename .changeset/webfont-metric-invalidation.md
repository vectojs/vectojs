---
'@vectojs/ui': patch
---

Re-measure six components after a webfont load (#681)

Button, Link, Text, Input, TextArea and RichText each measured once at
construction and cached per instance, so after a webfont finished loading
labels stayed mis-centered, wrap points went stale and carets drifted until an
unrelated edit re-measured. A shared `onFontMetricsChanged` signal in `measure.ts`
(wired to the existing `document.fonts.ready`/`loadingdone` listeners) now lets
each component clear its own caches and re-lay out once per load;
subscriptions are torn down on destroy.
