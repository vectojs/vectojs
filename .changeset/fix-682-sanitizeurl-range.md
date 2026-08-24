---
'@vectojs/core': patch
---

core: clamp out-of-range numeric character references in `sanitizeUrl`/`isSafeUrl` to U+FFFD instead of throwing RangeError (#682).
