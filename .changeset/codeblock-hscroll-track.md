---
'@vectojs/markdown': patch
---

CodeBlock now shows a horizontal scrollbar when lines overflow the box (#527). Wheel-only scrolling left a mouse-only reader with no way to reach a clipped tail and no indication one existed. The thumb is painted by the block itself so it can never lag the offset it reports; interaction (drag, track-jump) lives on a thin `role="scrollbar"` child strip inside the bottom padding, below the last selection carrier, so native drag-selection over the code is untouched.
