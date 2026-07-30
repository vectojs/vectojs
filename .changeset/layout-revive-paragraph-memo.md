---
"@vectojs/layout": minor
"@vectojs/ui": patch
---

Revive the paragraph memo, and put `fontFamily` in its key.

`LayoutEngine.prepare`/`prepareRich` discard every memoized paragraph when the
atlas argument is not the **same object** as the previous call — glyph advances
depend on it, so a changed atlas must invalidate. But `Text` and `RichText` both
passed a fresh `{}` literal on every layout, so the memo was cleared each time and
never hit: measured through the real `RichText`, five identical re-layouts produced
**0 hits and 12 misses**. A cache with a 1000-entry bound, eviction counters, and
~20 references was dead code on the only paths that used it.

Both now pass a new exported `EMPTY_GLYPH_ATLAS` (frozen, so one consumer cannot
poison another's advances). Measured through `RichText` on 20 paragraphs, 40
identical re-layouts: **54.52 ms → 26.78 ms**, hit rate **0 → 1.0**. Streaming
markdown is unchanged, as expected — it re-lays out _growing_ text, which is the
streaming shape cache's job, not the memo's.

Reviving the cache exposed a latent correctness bug, so both are fixed together:
`styleSig` fingerprinted `fontSize/color/bold/italic/href` but **not
`fontFamily`**, even though `fontFamily` is passed to `glyphWidth` and changes
advances. With a stable atlas, a `fontFamily: 'wide'` paragraph was served the
metrics of an identical-length `'serif'` one — 48px where 144px was correct.
Reachable in practice: `@vectojs/markdown` sets `fontFamily` on inline codespans,
so any paragraph containing `` `code` `` was the colliding shape. `fontFamily` is
now in the signature and in `styleRangeEquals`.

`@vectojs/layout` is a minor for the new `EMPTY_GLYPH_ATLAS` export; `@vectojs/ui`
is a patch (no API change, just correct cache usage).
