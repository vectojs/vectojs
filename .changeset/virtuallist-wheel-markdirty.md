---
"@vectojs/ui": patch
---

fix(ui): restore the markDirty() the VirtualList wheel handler lost

The deltaMode conversion in #401 rewrote `VirtualList`'s wheel handler and
dropped its trailing `this.scene?.markDirty()`. That call is not redundant with
`hasPendingAnimations()`: `Scene.loop()` decides idleness from
`frameHadAnimation`, which is only refreshed during a **rendered** frame's tree
walk. Once a scene has gone idle it skips that walk entirely in
`renderMode: 'onDemand'`, or drops to 2 FPS in `'always'` with `autoThrottle` —
so nothing observes the new `_targetY` and the wheel scroll either never starts
or starts a half-second late. `markDirty()` is what wakes the first frame, and
every other path that moves `_targetY` (`pointermove`, `scrollToBottom`,
`setItems`) already calls it.

`WheelDeltaMode.test.ts` is rewritten in the same change. It had defined a local
copy of the conversion arithmetic and asserted against that copy, so it passed
regardless of what `ScrollView`, `Table`, `Tree`, `VirtualList`, or `Tabs`
actually did — including with this `markDirty()` missing. It now emits real
wheel events at the real components and asserts on their observable scroll
state, covering pixel/line/page mode for all five widgets plus the `markDirty()`
regression (verified failing before the fix).
