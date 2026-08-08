---
"@vectojs/core": patch
---

fix(core): ignore a `Scene.resize()` with negative or non-finite dimensions

`resize(width, height)` stored its arguments verbatim (`this.width = width`) and
then passed them to the renderers. A canvas element's `width`/`height` setters
clamp or no-op on a bad value, so `Scene.width` could read `-10` (or `NaN`) while
the backing store sat at `0` — the logical viewport and the backing store
disagreeing, with culling and a11y geometry computed from the bogus value. The
failure is silent: nothing throws, the scene simply reasons about a viewport that
does not exist.

`resize()` now rejects a negative or non-finite dimension, keeping the last
known-good size and leaving the canvas untouched, and warns once.

Rejecting rather than clamping is deliberate: clamping invents a viewport the
caller never asked for and hides the bug at the call site, whereas returning
leaves the previous size intact, which is the safer state for a formula-driven
resize that briefly produces garbage. The warning is latched because `resize()`
is commonly driven from a `ResizeObserver` and would otherwise warn on every
frame of a drag.

`0` remains a valid argument. `start()` already treats a zero-size scene as
warn-worthy but tolerated, so rejecting `0` here would contradict that policy;
the DPR-change handler also re-invokes `resize(this.width, this.height)`, which
on a legitimately zero-size scene must still rescale the backing store. The
internal `ResizeObserver` path already filters `w > 0 && h > 0` before calling
`resize()`. Recorded as carryctx `DEC-0013`.

Unit tests: 10 cases in `packages/core/test/Scene.test.ts` covering negative
width/height, `NaN`, `±Infinity`, warn-once latching, and the over-rejection
directions (a valid resize, a zero resize, and a valid resize following a
rejected one). Verified fail-old: 7 fail without the guard.
