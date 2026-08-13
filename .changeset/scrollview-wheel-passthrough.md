---
'@vectojs/ui': patch
---

ScrollView no longer consumes wheel events when its content already fits the viewport (#525). The handler used to `preventDefault` before asking whether there was anything to scroll, so a short ScrollView turned its whole band into a page-scroll dead zone: the wheel did nothing inside it and the page underneath never moved. The wheel now passes through to the page whenever `maxScroll` is zero.
