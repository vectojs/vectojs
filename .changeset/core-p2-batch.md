---
'@vectojs/core': patch
---

Three rendering-loop fixes. (1) `a11ySyncInterval` no longer loses to the pending-after-animation bypass: the pending flag re-armed itself every frame while an animation was in flight, so the a11y shadow-DOM sync ran per frame instead of at the configured interval; the bypass now fires only once the animation has stopped. (2) `WasmBackendFacade.setTransform` now detects a backend identity change (e.g. re-enabling transforms after `setWasmRuntime(sharedRuntime)`) and invalidates the resident store, so the new backend receives `uploadRuns` instead of skipping the rebuild and rejecting every frame. (3) `CanvasRenderer.flush()` now syncs the cached fill style to the batch color it painted and restores the caller's `globalAlpha` instead of forcing 1, so a subsequent fill of the previously cached color no longer paints with the stale batch color.
