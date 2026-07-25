---
"@vectojs/layout": patch
"@vectojs/markdown": patch
---

Three streaming/Markdown text-correctness fixes:

- **Streaming reshape froze word boundaries** (`LayoutEngine`): the incremental fast path re-segmented only the last cached word, so text streamed character-by-character kept spurious boundaries a one-shot shape never produces — `"3"→"."→"1"→"4"` became `["3", ".", "14"]` instead of `["3.14"]`, and decimals / URLs / abbreviations streamed live wrapped wrong. It now re-segments the whole trailing same-category (whitespace vs non-whitespace) run, which is the exact boundary the appended suffix cannot dissolve, so every streamed prefix now matches a from-scratch shape.
- **`updateTokens` child-index desync** (`Markdown`): the token→child-entity index map (and the removal loop) skipped only `space` tokens, but a non-SVG raw `html` block (e.g. an HTML comment or bare `<div>`) and a fallback token without `text` also render no entity. A null-rendering token before the growing tail shifted every subsequent entity index by one, so the wrong entity was updated or destroyed — common in LLM Markdown. Introduced a `producesEntity()` predicate kept in lockstep with `renderToken`'s null returns and used by both the index map and the removal loop.
- **Inline-math tokenizer ate currency** (`Markdown`): `$…$` matched greedily, so "costs $5 to $10" became a single math span. The tokenizer now requires the opening `$` to not be `$$` and to be followed by a non-space, non-digit, and the closing `$` to be preceded by a non-space and not followed by a digit (pandoc-style). Genuine `$x+1$` still tokenizes; "$5 to $10", "$9 each", and "$$" do not. Applied to both the main-thread and worker tokenizers (regenerated `MarkdownWorkerSource`).
