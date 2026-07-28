---
"@vectojs/markdown": patch
---

Discard an in-flight worker reply when `setContent()` replaces the document

A worker request dispatched before `setContent()` was still applied after it. The
reply's `matchLen` is relative to a token snapshot captured from the document
being replaced, and its closure still holds that snapshot, so applying it rebuilt
the tree from a document that no longer existed: `rawMarkdown` held the new text
while `tokens` reverted to the old, and the next append then diffed against
tokens the source never had.

`setContent()` now drops any pending callbacks — as `destroy()` already did — and
clears the in-flight flag. Both halves are required: the flag gates every
dispatch, so dropping the callback alone would leave the next append waiting
forever for a reply that can no longer arrive.

Reachable from switching conversation threads mid-stream, or any
`setContent()` while a chunk is outstanding.
