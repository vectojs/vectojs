---
'@vectojs/core': minor
'@vectojs/ui': minor
---

Add a unified, spring-first animation system.

`@vectojs/core` gains an easing library (`Easing`), per-property spring/tween
drivers, and a declarative + imperative API on `Entity`: `setTransition` (assign
a configured property and it animates), plus `animateTo` / `springTo` (imperative,
Promise-returning). The six transform/visual properties (`x`, `y`, `scaleX`,
`scaleY`, `rotation`, `opacity`) are now accessors with a zero-overhead fast path
when no transition is configured (benchmarked: 5000 writes/frame ≈ 89µs, 0.5% of a
60fps budget). Legacy `Entity.animate()` is preserved. Adds an `onMounted`
lifecycle hook and honors `prefers-reduced-motion` (movement snaps, opacity fades).

`@vectojs/ui` gains a shared enter/exit presence helper on `UIComponent`
(`enterMotion` / `exitMotion` / `dismiss`). `Modal` and the `Overlay` family
(`Tooltip` / `Popover` / `ContextMenu`) now animate through the shared system,
replacing their bespoke `SpringPhysics` and hand-rolled lerps.
