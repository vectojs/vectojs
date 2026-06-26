---
'@vecto-ui/core': patch
---

Add `Scene.a11ySyncInterval` to throttle the accessibility/automation shadow-DOM sync.

By default the shadow layer syncs every rendered frame. Under heavy animation those per-frame DOM writes (position/size/attr updates) can drag Canvas FPS. Set `a11ySyncInterval` (ms, e.g. `100`) — via `SceneOptions` or the property — to cap the sync rate; the a11y/automation layer stays eventually consistent while the render loop keeps its frames cheap. Default `0` preserves the every-frame behavior.
