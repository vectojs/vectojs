---
'@vectojs/ui': patch
---

Stop leaking a measuring canvas per `RichText`

`baseMeasurer` called `createMeasuringContext()` directly, bypassing the memo in
`measure.ts` that exists to make that context a singleton.
`createMeasuringContext` appends its canvas to `document.body`, and
`baseMeasurer` runs from the `RichText` constructor, so every `RichText` ever
built left a permanent 1×1 `<canvas>` in the document.

Measured in real Chrome on one 17 KB markdown document: **205 leaked measuring
canvases** (2 → 8 → 48 → 141 → 206 across the load), each holding a live
`CanvasRenderingContext2D`. The JS heap was healthy throughout — 25 MB settled,
collecting normally — because a canvas element's real cost is not on the JS heap;
process memory reached 277 MB. Streaming compounded it, since every re-render
builds fresh `RichText`s, so a long session grew without bound. After the fix the
same document holds exactly **one** measuring canvas.

The canvas is still attached, which is the property that matters: Firefox
resolves generic font families against the document, so a detached measuring
canvas reports `monospace` 20% narrow and the following run overlaps the previous
one's tail. Sharing one attached context preserves that and shares nothing else —
each measurer keeps its own width cache, and every `measure()` assigns
`ctx.font` before reading.
