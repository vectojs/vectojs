---
'@vectojs/devtools': minor
'@vectojs/markdown': minor
---

Add a Markdown streaming inspector.

The component's descriptor already carried appends, worker responses and token
reuse. Three things the item asked for were missing and are now recorded: worker
round-trip time (mean and worst), the stable-prefix and changed-tail lengths in
**characters**, and reused vs rebuilt vs updated-in-place child entity counts.

`inspectMarkdownStream(entity)` reads those and derives the two quantities worth
watching. Characters matter because token counts do not answer the question: a
stream can reuse 95% of its tokens while still re-reading 60% of its characters
every chunk, and only the character ratio shows the O(document)-per-chunk shape.
Coalescing is derived as appends minus responses, but reported as zero when the
worker never answered — otherwise a main-thread parse claims every append was
coalesced when none were.

`auditMarkdownStreaming(scene)` reports five classes: `tail-not-a-delta`,
`low-token-reuse`, `slow-worker-roundtrip`, `no-worker` and
`entities-mostly-rebuilt`. The first two fire independently, since they fail
independently.

The inspector reads the descriptor rather than importing `@vectojs/markdown`,
keeping the dependency pointing the right way and the module out of the headless
bundle's forbidden-import set.
