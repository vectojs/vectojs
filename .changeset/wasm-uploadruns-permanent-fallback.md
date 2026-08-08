---
"@vectojs/core": patch
---

fix(core): fall back to JS transforms permanently after repeated WASM run-table rejections

When `backend.uploadRuns()` rejected the run count, `_syncWasmStore` left
`_storeStructureVersion` stale so the next frame retried the rebuild. That is
correct while the cause might be transient — the published run table still
describes the PREVIOUS topology, so composing against it would lay this frame's
entities out along last frame's parent links.

But when the rejection is persistent (a topology that genuinely exceeds the
crate's hard run cap) the retry never succeeds, so the scene rebuilt the whole
O(n) transform store and re-failed the upload **every frame, forever**, with no
escape to the JS path. The scene stayed visually correct throughout — JS
composition is the permanent fallback — while paying a full `buildTreeStore` plus
a run-table upload per frame for an accelerator that could never engage.

Consecutive rejections are now counted and reset by any success, so an
intermittent rejection never accumulates. On the third consecutive rejection the
transform backend mode flips to `'js'` for the scene's lifetime and the rebuild
stops, with one latched warning reporting the run and entity counts so the
topology is diagnosable. `_transformBackend` is the field the render walk already
reads, so no parallel disable flag was added; an explicit
`scene.setTransformBackend(backend)` re-enables WASM and clears the streak.

The threshold and the re-enable policy are recorded as carryctx `DEC-0014`: 3
rather than 1 because the retry is a deliberate documented design, and rather
than a larger number because each retry's cost scales with tree size and a hard
cap will never be cleared by retrying.

`_ensureWasmAabbs`'s rejection path is deliberately unchanged — it already
returns `false` and falls back to the JS gather, which is a per-query fallback
rather than a per-frame rebuild.

Unit test: `packages/core/test/wasm/scene-wasm-upload-fallback.test.ts`, driven
through a stub backend so it runs without the (gitignored) `.wasm`. Verified
fail-old: 6 of its 7 tests fail without the change, and the one that passes is the
over-rejection guard (a healthy backend is never disabled).
