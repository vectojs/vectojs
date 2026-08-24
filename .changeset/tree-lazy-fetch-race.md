---
'@vectojs/ui': patch
---

Stop Tree lazy-load duplicate fetches on re-expand (#690)

Expanding a lazy node starts its fetch; collapsing and re-expanding before
the promise resolved passed the same `!loaded` guard again and invoked
`children()` a second time, with last-writer-wins on `_loaded` — duplicate
work and nondeterministic children for non-idempotent loaders. The toggle now
also skips when a load is already in flight; the existing `finally` cleanup
keeps retries after rejection working.
