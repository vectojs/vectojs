---
'@vectojs/markdown': patch
---

Fix a fenced code block staying a plain `CodeBlock` forever when its registered plugin renderer finishes loading _after_ the fence was already rendered. `ensureFencedBlockRenderer` was fire-and-forget: a one-shot `new Markdown('```mermaid\n...\n```')`, a `setContent()`, or a fence closed in the final stream chunk built the fallback `CodeBlock` and nothing re-rendered when the load resolved. The code arm now schedules a rebuild (coalesced per instance via `fencedRebuildPending`, guarded by `isDestroyed` and `isFencedBlockRendererReady`) so the plugin entity replaces the placeholder; a renderer that loads but returns `null` remains a permanent fallback and never rebuilds.
