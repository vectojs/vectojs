---
'@vectojs/ui': patch
---

Backlog hardening for ui primitives (#654): removed the unused `measure.wrapLines` export (its greedy wrapping diverged from the LayoutEngine every component actually uses); `Slider` now takes a typed `SliderOptions`, validates `step > 0` and `max >= min` at construction, and routes its initial value through the same clamp/snap path as mutations; `ProgressBar` clamps its initial value via `setValue`, treating non-finite input as 0; `Input`/`TextArea` gained a `label` option (accessible name, falling back to placeholder) and a projected `disabled` state; `disabled` support was standardized across Checkbox/Toggle/Link following the Button pattern; the measure cache no longer aliases `(font, text)` pairs joined on a space; `RichText.logicalRuns` stops scanning spans past the requested line end.
