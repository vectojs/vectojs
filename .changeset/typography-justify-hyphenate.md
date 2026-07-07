---
'@vectojs/core': patch
---

Typography: LayoutEngine gains textAlign 'justify' (stretches inter-word spaces, or inter-character gaps on space-less CJK lines, so wrapped lines end flush; paragraph-final lines stay ragged) and wrap-time hyphenation — soft hyphens (U+00AD) break with a visible '-' out of the box, and a pluggable hyphenate hook supplies break parts for plain words. TextEntity exposes setTextAlign()/setHyphenator().
