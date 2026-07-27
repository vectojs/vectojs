---
'@vectojs/core': minor
'@vectojs/devtools': minor
---

Add dirty-reason attribution, so you can find out what keeps an `onDemand` scene awake.

`renderMode: 'onDemand'` exists so an idle scene costs nothing, but it silently
degrades to always-on the moment something marks the scene dirty every frame — and
`dirty === true` says only *that* it happened, never *what* did it. Diagnosing that
meant bisecting `markDirty()` call sites by hand.

`markDirty()` now takes an optional source:

```ts
scene.markDirty({ entity: this.id, reason: 'text-changed', property: 'spans' });
```

Attribution is off by default and recording costs nothing until
`scene.setDirtyTracking(true)`, because `markDirty` is called from dozens of sites,
several per frame, so the common path stays a single field write. Read the
aggregated counts from `scene.dirtyReasons`.

The engine's own call sites already carry attribution, so an animation or a
child add/remove is identifiable without instrumenting anything.

`@vectojs/devtools` adds `diagnoseDirty(scene)` (also on the `headless` entry),
which turns the counts into a verdict:

```
Continuous redraw detected: answer — streaming-text marked the scene dirty
120x over 120 frames (1.00/frame). onDemand cannot idle while this continues.
```

It distinguishes a cause firing every frame from one that merely fired often, and
says plainly when `renderMode` is `'always'` (which makes the whole question moot)
or when tracking was never enabled — reporting "no causes" in that case would read
as a false all-clear.
