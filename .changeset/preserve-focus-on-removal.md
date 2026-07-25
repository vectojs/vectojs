---
"@vectojs/core": patch
---

Preserve focus when a focused a11y projection is virtualized, streamed away, or otherwise removed. Removing the DOM element that holds `document.activeElement` drops focus to `<body>`, which yanks a screen reader out of the scene's a11y region back to the top of the page — the classic "lost my place on scroll/stream" bug for `VirtualList`-recycled or streamed controls. `Scene` now keeps a persistent `tabindex=-1` focus sentinel inside `a11yRoot` (kept last in DOM order); when the focused mirror is pruned at any of the three removal sites (`removeA11yRecursively`, the runtime tag-change path, and the `enforceA11yDomOrder` prune) while it is the active element, focus moves to the sentinel first, so it stays within the app region instead of collapsing to the document body.
