---
"@vectojs/ui": patch
---

fix(ui): convert WheelEvent deltaMode in all scroll widgets

ScrollView, Table, Tree, VirtualList, and Tabs now scale wheel deltas by 16px (line mode, deltaMode=1) or viewport dimension (page mode, deltaMode=2) before applying. Previously, line-mode and page-mode wheels scrolled at ~1-3px per notch instead of the expected ~48px or one viewport height.

Unit test: `packages/ui/test/WheelDeltaMode.test.ts`
Finding: `vectojs-docs/forge/findings/ui-components.md` (2026-08-08 entry)
