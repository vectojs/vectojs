---
'@vectojs/dom': patch
---

Fix DOM render/hit agreement and projection bookkeeping (CTX-0607, closes #861): `DOMProjection.update` now clips each projected element to its `clipChildren` ancestor intersection via CSS `clip-path` (new exported `clipPathForNode` helper, dirty-checked with a `clipWrites` counter), so DOM rendering matches `HitTester` gating; remounts restore the node's first-mount z-index instead of taking a fresh slot, keeping paint order stable across unmount/remount cycles; the gesture election now records the owning node id with first-wins semantics plus a per-bridge `hasGesture` pin, so one scene's release can no longer clear another scene's live gesture (`getGestureOwner` returns the owning node id rather than the constant `'dom'`).
