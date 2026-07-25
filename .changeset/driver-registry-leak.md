---
"@vectojs/core": patch
---

Stop `scene.remove()` from leaking still-animating entities. An entity spawns a property driver by registering itself in the Scene's batched-driver candidate set, which is only self-pruned when the driver _completes_. Removing an entity mid-animation (a route change on a spinner, a dismissed toast still easing out) never unregistered it, so it stayed pinned in the set — a memory leak — and its drivers kept ticking every frame even though it was off-tree. `scene.remove()` / `hideOverlay()` now unregister the whole removed subtree, and `scene.add()` / `showOverlay()` re-register any node that still has live drivers, so re-attaching a subtree that was removed mid-animation resumes its motion.
