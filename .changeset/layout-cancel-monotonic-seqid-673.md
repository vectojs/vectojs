---
'@vectojs/layout': patch
---

`cancelLayout` no longer resets an entity's seqId counter. Replies are keyed `entityId-seqId`, so restarting at 1 let a stale reply from a just-cancelled in-flight request match the next request's pending entry and deliver the old geometry to the new callback (the genuine reply was then dropped). Counters stay monotonic for the manager's lifetime.
