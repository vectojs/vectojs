---
'@vectojs/core': patch
---

Repaint synchronously when the device pixel ratio changes, so a zoom step no
longer flashes.

The `(resolution: Ndppx)` handler re-ran `resize`, which assigns
`canvas.width`/`canvas.height` — and per spec that clears the backing store even
when the value is unchanged. The repaint was left to the next animation frame, so
the canvas was transparent in between and a full-viewport scene showed its page
background on every zoom step or monitor move.

The handler now renders in the same task, matching what the context-restored path
already did. Skipped while the drawing context is lost, where every draw call is a
no-op and the `contextrestored` handler owns the repaint.
