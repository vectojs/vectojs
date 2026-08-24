---
'@vectojs/layout': patch
---

Remove the dead `lineMax` initializer in the zero-GC buffer layout path (`layoutPreparedIntoBuffer`). The paragraph line maximum is now derived where it is first used, as a per-iteration constant. No behavior change — flagged by CodeQL (`js/useless-assignment-to-local`).
