---
"@vectojs/layout": minor
---

Lay out MSDF text on the main thread when the layout worker is unavailable or fails, instead of leaving it permanently unrendered.

`MSDFTextEntity.render()` returns early while its `layoutResult` is null, and the only thing that ever set it was a `LayoutWorkerManager` callback. Those callbacks were discarded whenever the worker failed and dropped outright when no worker could be created, so text stayed invisible forever while its box, hit-testing, and DOM content projection all still reported success.

A Content-Security-Policy that blocks `blob:` workers is the realistic trigger. Measured on Chromium and Firefox: `new Worker(blob:…)` does not throw under `worker-src 'none'`, a `script-src` without `blob:`, or `default-src 'self'` — it constructs and then fires `onerror`, so a CSP was indistinguishable from a crash except that it never stopped happening. Six layout requests spawned six Workers and delivered zero layouts.

- The wrapping algorithm moved into a new exported `computeMSDFLayout(request, font)`, which the worker and the main thread now both call, so fallback geometry is identical rather than merely similar.
- A failed or unavailable worker completes its queued requests synchronously.
- Font metrics are retained per font id, so a fallback still works for a caller that passed `fontData` only on the first request.
- Worker recreation is capped at two consecutive failures, after which layout stays on the main thread.
- `new Worker` throwing no longer escapes `queueLayout` into `new MSDFTextEntity(...)`.
