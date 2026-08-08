---
"@vectojs/core": patch
---

fix(core): ignore `Scene.start()` on a destroyed scene

`start()` checked only `isRunning`, so calling it after `destroy()` flipped
`isRunning` back to `true`, re-armed `scheduleFrame()` and the caret blink timer,
and ran the render loop against a disposed renderer and removed a11y/projection
DOM.

That does not throw. `CanvasRenderer.dispose` releases its resources but leaves
the 2D context in place, so the resurrected loop keeps drawing — into a canvas
that is no longer in the document. The result is a scene that looks stopped,
holds a 500ms `setInterval` calling `markDirty()` forever, and burns a frame
budget on output nobody can see.

`start()` now returns early when `destroyed` is set, matching the guard
`destroy()` itself uses and the one in `recreateWebGPUDeviceWithRetry`. It stays
a silent no-op rather than warning: `start()` is documented as idempotent, so
defensive calls from teardown paths are legitimate and a warning would be noise.
A merely stopped scene still restarts, which `stop()`'s documented resumability
requires.

Unit tests in `packages/core/test/Scene.test.ts` cover both halves of the restart
(no scheduled frame, no caret timer) plus the over-rejection direction, and were
verified fail-old.
