---
'@vectojs/video-exporter': patch
---

fix(video-exporter): frame 0 no longer depends on page-load timing (#646)

The export sequence loaded the page (`networkidle0`), sized the canvas and
stopped the scene — but between load and `stop()` the page's own rAF loop
free-runs, so wall-clock-driven state (intro tweens, eased entrances) was
arbitrary by capture time; every later frame was deterministic only from that
nondeterministic base. After stopping, the exporter now calls an optional
`window.vectoScene.reset()` once, before the fixed-step loop begins: scenes
that render static until their first `step(dt)` are unaffected, scenes that
carry load-time state return to their t=0 presentation. The README scene
contract documents the requirement loudly.
