---
"@vectojs/layout": patch
---

Make `LayoutWorkerManager` (and therefore `MSDFTextEntity`) SSR-safe. `createWorker` had no environment guard, so constructing an `MSDFTextEntity` where `Worker`/`Blob`/`URL` are undefined (server-side rendering, non-DOM) threw — contradicting the "SSR-safe" contract the Markdown worker path already honored with its `typeof Worker` guard. `createWorker` now returns `null` in those environments, `ensureWorker` propagates it, and `queueLayout` no-ops (dropping the pending callback rather than retaining it) when no worker can be created. Layout resolves normally once the entity is used in a real browser, where a fresh `queueLayout` creates the worker.
