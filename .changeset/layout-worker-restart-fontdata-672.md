---
'@vectojs/layout': patch
---

After a layout-worker restart, queued layouts no longer hang when the caller omits `fontData`: the manager now re-attaches its retained font metrics to any request whose font the (new) worker has not registered, instead of letting the worker's unknown-fontId guard swallow it silently.
