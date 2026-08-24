---
'@vectojs/devtools': patch
---

fix(devtools): selection audit no longer clears the user's live text selection (#708)

The selection audit captured `getSelection()` at entry and unconditionally
called `removeAllRanges()` on the way out — but its measurements use detached
ranges (`document.createRange()` + `selectNodeContents()`), which never touch
the DocumentSelection. There was no programmatic selection to clean up, so the
trailing call destroyed whatever the user (or a CI/QA driver) had selected as a
side effect of a read-only audit. The capture and the call are gone.
