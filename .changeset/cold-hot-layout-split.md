---
'@vecto-ui/core': patch
---

Add a cold/hot layout split to `LayoutEngine` to kill per-frame layout thrashing.

- **Cold pass** `prepare(text, atlas, fontSize): PreparedText` runs `Intl.Segmenter`
  plus glyph measurement once and returns a constraint-independent, reusable result.
- **Hot pass** `layoutPrepared(prepared, mask?)` / `layoutPreparedIntoBuffer(...)`
  does only wrap/positioning arithmetic — no re-segmentation, no re-measurement —
  so reflow on resize/reposition is cheap. `layoutText`/`layoutTextIntoBuffer` now
  delegate to these (behavior unchanged).
- `TextEntity` caches its `PreparedText`: new `setText()` re-prepares (content
  changed) while new `setMaxWidth()` reflows via the hot path only.

Micro-benchmark (472-char Latin+CJK paragraph, warm caches): reflow is **~3.5×**
faster on the hot path (0.021 → 0.006 ms/reflow). Exports `PreparedText`,
`PreparedParagraph`, `PreparedWord`, `PreparedGlyph`.
