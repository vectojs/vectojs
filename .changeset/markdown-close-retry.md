---
'@vectojs/markdown': patch
---

Fixes #702: `StreamController.close()` no longer resolves success after a previously failed close. The state flipped to `'closed'` before the host `onClose` hook ran, so once the hook threw or rejected, a retried `close()` hit the closed short-circuit and resolved — reporting success although settlement never ran. The pending/settled `closePromise` is now checked before every short-circuit, so all callers observe the original outcome; retries after a successful close still resolve.
