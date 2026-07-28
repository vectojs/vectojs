---
'@vectojs/layout': minor
---

Expose cache statistics and per-glyph atlas misses.

`LayoutEngine.cacheStats()` reports hits, misses, evictions, size, capacity and
hit rate for the word, grapheme, paragraph and rich-paragraph caches;
`resetCacheStats()` zeroes the tallies without discarding entries. `hitRate` is
`null` until a cache has been consulted, because "never used" and "used and
always missed" are different diagnoses.

These caches are the difference between O(appended) and O(document) on a
streaming paragraph, and there was previously no way to tell whether one was
working. A key that varies by accident turns every lookup into a miss and the
memo into pure overhead, with no symptom other than being slow.

`PreparedGlyph.atlasMiss` records which glyph the atlas lacked. The engine already
computed this to set the paragraph's `fallbackToCanvas` flag and then discarded
it, so "some glyph in this paragraph fell back" was the finest granularity
available — not enough to find the character responsible. Set on all three shaping
paths (plain, rich, streaming fast path), and consistently excludes whitespace,
matching how the paragraph flag already treats it.
