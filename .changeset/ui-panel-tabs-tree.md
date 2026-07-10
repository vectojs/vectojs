---
'@vectojs/ui': patch
---

ResizablePanel: drag the divider in scene space instead of the handle`\s local space, so resizing tracks the cursor 1:1 (the handle moves with the panel it resizes, so a local coordinate lagged the pointer); a drag no longer aborts when the cursor briefly outruns the thin handle. Tabs: add `closable`/`onClose`(per-tab × affordance), and keep a fixed`tabWidth`(default 160, floor`minTabWidth`96) with horizontal wheel scrolling + auto-scroll-to-active instead of shrinking to slivers as the tab count grows; long labels truncate with an ellipsis. Tree:`TreeNode.iconColor` for material-style colored file icons.
