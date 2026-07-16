---
'@vectojs/ui': patch
---

Keep the Input/TextArea caret blinking under the idle throttle. The blink phase
comes from `Date.now()` inside `render()`, which the Scene's idle detection
cannot see, so a focused field in an `onDemand` scene froze its caret solid
(and blinked erratically under the 2 FPS auto-throttle). A focus-scoped
wake-up now marks the scene dirty at each 500 ms phase boundary and is cleared
on blur and destroy. Also regenerated `MarkdownWorkerSource.ts` from the
current `marked` version and wired `scripts/build-worker.js` into the build so
the generated worker can no longer drift from the lockfile.
