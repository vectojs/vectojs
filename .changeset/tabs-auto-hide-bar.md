---
'@vectojs/ui': patch
---

Tabs: new opt-in `autoHideTabBar` option (Vim `showtabline=1` semantics) — the tab bar hides while there are fewer than two tabs and the content occupies the full height, reappearing as soon as a second tab is added. The hidden strip is inert for pointer input, `effectiveTabBarHeight` exposes the current bar height for owners laying out around it, and content geometry now re-syncs every frame so direct `tabs` field reassignment (without a `change` emit) can no longer leave the active content offset or stale.
