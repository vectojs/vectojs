---
'@vectojs/devtools': patch
---

fix(devtools): clear the August review backlog — shadowed exports, plugin id collisions, overlay-blind audits, clip divergence, O(P²) reading order

Six low-severity findings from the 2026-08 code-review sweep (#660):

- `index.ts` no longer re-exports `diagnoseDirty` and the accelerator helpers
  explicitly; the headless star export already carried them, and two export
  paths for one symbol invited silent drift.
- Duplicate plugin inspector ids now warn and suffix (`id#2`, …) instead of
  colliding on both the tab id and the row map, where the second registration
  silently won and the first tab read rows from the wrong inspector. Ids are
  memoized per inspector so repeated refreshes keep the same tab.
- `gpuInspect`, `textInspect` and `markdownInspect` audits walk
  `scene.overlayRootEntity` as well: overlay-mounted particles, atlas-miss text
  and streaming markdown were invisible to the counters, and webgpu bind-group
  counts undercounted by 2× missed entities.
- The `clip` highlight layer computes `divergesFromLayout` via the shared
  `diverges()` predicate like every other layer, instead of hardcoding `true`
  and stroking weight-2 highlights for entities that exactly fill their
  clipper.
- `a11yReadingOrder` builds one document-order element→position map per pass;
  per-entity lookups previously paid a `querySelectorAll` plus an O(P) scan per
  projected node (quadratic on document-sized projections). Single-entity
  `inspectA11y` calls are unchanged.
- Minor: one bidi resolution per text inspection (was two), `hitExplain` docs
  cite `HitTester.findHitRecursively`/`isPointerTransparent` where those methods
  actually live, and panel `showTab` routes through the public `Tabs.selectTab`.
