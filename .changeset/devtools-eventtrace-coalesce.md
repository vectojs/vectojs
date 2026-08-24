---
'@vectojs/devtools': patch
---

fix(devtools): EventTrace coalesces pointermove instead of picking per event (#707)

With `traceEvents` enabled every document `pointermove` ran `resolveContext`;
for canvas-targeted moves that is `pickInScene` — a full O(n) reverse tree walk
— at input-event rate (120–240 Hz), with each accepted entry rewriting trace
rows and repainting the panel scene. The observer effect skewed the very frame
times the perf HUD reports. Moves are now coalesced to at most one traced entry
per 16ms window (leading-edge, on the event `timeStamp` clock); discrete events
(pointerdown/up/cancel, wheel, keys) are never coalesced.
