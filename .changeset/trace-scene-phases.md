---
'@vectojs/core': minor
'@vectojs/markdown': minor
---

Add default-off User Timing instrumentation for Scene render phases and Markdown parsing. Enable it per instance with `userTiming: true` or `setUserTiming(true)` to emit stable `vecto:scene:*` and `vecto:markdown:parse` marks and measures for browser traces and profiles.
