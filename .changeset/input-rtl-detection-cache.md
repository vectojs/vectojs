---
'@vectojs/ui': patch
---

`Input` no longer re-scans the entire value for RTL-script characters on every `charOffset()` call. The scan ran uncached, and a single render (or caret blink) tick could call `charOffset()` several times (caret position, selection start, selection end, composition bounds) plus once more inline in the selection-highlight branch — each redoing the same O(n) scan from scratch. It's now cached alongside the existing layout cache, invalidated only when `value` changes.
