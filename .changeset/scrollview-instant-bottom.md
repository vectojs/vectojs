---
'@vectojs/ui': patch
---

Fix `ScrollView.scrollToBottom()` retargeting the scroll spring on every call instead of snapping instantly. Callers that track growing content (e.g. a streaming chat auto-following new tokens) call this many times a second, which never let the spring settle — the viewport visibly jittered instead of tracking the newest content. Wheel/drag scrolling is unaffected and still springs.
