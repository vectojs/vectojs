---
'@vectojs/ui': patch
---

Fix VirtualList swallowing wheel when content fits (#679)

The wheel handler called `preventDefault()` before checking `_maxScroll()`,
so an empty or fitting list turned its band into a page-scroll dead zone.
It now returns before consuming the wheel when there is nothing to scroll,
mirroring ScrollView's #525 guard.

Fixes #679
