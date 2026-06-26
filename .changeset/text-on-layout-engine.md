---
'@vecto-ui/ui': patch
---

Route `Text` through the shared `LayoutEngine` instead of its own ad-hoc
`wrapLines`. `Text` now uses the same `Intl.Segmenter` measurement path as
`TextEntity`, with the cold/hot split: `setText` re-measures (cold), the new
`setMaxWidth` re-wraps via the hot path only (no re-segmentation/re-measurement).
Blank lines and explicit newlines are preserved. Public `measureText` /
`wrapLines` / `fontSizePx` are unchanged and still exported.
