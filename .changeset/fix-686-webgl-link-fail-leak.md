---
'@vectojs/core': patch
---

core: `createWebGLPointRenderer` no longer leaks on a failed shader link (#686). Programs that already linked are deleted before returning null, and the GL context is released via `WEBGL_lose_context`, so init retries after a driver hiccup no longer accumulate a program generation plus a resident context per attempt.
