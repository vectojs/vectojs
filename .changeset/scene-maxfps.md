---
'@vecto-ui/core': patch
---

Add power-saving render controls to `Scene`.

- `Scene.maxFPS` (and `SceneOptions.maxFPS`): cap the render loop to N frames per
  second (`0` = uncapped). Continuous animations still run, just less often —
  fewer GPU/CPU cycles (e.g. a quieter fan in a library). The loop skips frames
  that arrive sooner than the target interval; `dt` stays accurate because
  `lastTime` only advances on rendered frames.
- `respectReducedMotion` (default `true`): a system **prefers-reduced-motion**
  setting auto-caps the loop to `REDUCED_MOTION_FPS` (30), or the lower of that
  and `maxFPS`. Also an accessibility win. Set `false` to ignore the OS setting.
