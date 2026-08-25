---
'@vectojs/markdown': patch
---

Fix streamed in-place reuse for affordance-wrapped code and table blocks (#789): the streaming reconciler's `updateStreamedTable` guard, blockquote-tail code mutator, and mid-stream code arm now look through `BlockWithAffordances` (mirroring #701's setMaxWidth fix) and refresh the wrapper's controls after a mutation moves geometry. With `blockAffordances` enabled, growing fenced blocks and tables take the fast path again instead of rebuilding every chunk.
