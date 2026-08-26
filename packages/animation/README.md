# @vectojs/animation

`@vectojs/animation` is the standalone motion layer of the VectoJS graph: a shared easing library
plus tween and spring property drivers over one `PropertyDriver` contract. It sits directly above
the `@vectojs/math` leaf (for the spring integrator) and is re-exported by `@vectojs/core`, whose
`Entity.animate()`, `setTransition()`, `animateTo()`, and `springTo()` are all backed by these
drivers — import it directly to drive custom values or build your own motion surfaces.

## Install

```bash
bun add @vectojs/math @vectojs/animation
```

`@vectojs/math` is a runtime dependency and is installed automatically.

## Usage

```ts
import { Easing, SpringDriver, TweenDriver } from '@vectojs/animation';

const tween = new TweenDriver(0, 100, { duration: 400, easing: 'easeOutCubic' });
const spring = new SpringDriver(0, 100, { stiffness: 180, damping: 12 });

function frame(dtMs: number) {
  tween.tick(dtMs);
  spring.tick(dtMs);
  console.log('tween', Math.round(tween.value), 'spring', Math.round(spring.value));

  // Retarget mid-flight: springs keep velocity, tweens restart from value.
  if (!tween.isDone()) tween.retarget(tween.target + 10);
  if (spring.isDone()) console.log('settled on', spring.target, Easing.linear(1));
}
```

## Highlights

- One shared config shape, `MotionConfig`: a config with `duration` selects a tween, anything else
  selects a spring (`isTweenConfig()` implements the discriminator exactly) — the same shape every
  VectoJS motion surface accepts.
- `TweenDriver(from, to, { duration, easing?, delay? })` over the curated `Easing` set (linear,
  quad/cubic in-out, back overshoot) or any custom `(t) => number`; named easings carry numeric ids
  via `EASING_IDS` so batched WASM ticking can address them.
- Retarget semantics that cannot starve: a tween's startup delay is charged once on the monotonic
  clock, so rapid retargets never re-consume it; a finished tween or spring always lands exactly on
  target rather than within an epsilon.
- `SpringDriver(from, to, { stiffness?, damping?, mass? })` wraps `SpringPhysics` with defaults
  180 / 12 / 1; config validation throws loudly on non-finite or non-positive values instead of
  wedging `isDone()` forever.
- `syncExternal(value, extra)` writes back externally-advanced state so drivers stay correct when
  their math ran elsewhere — the hook Core's batched WASM animation kernel ticks through.
- Zero rendering coupling: drivers write a plain `value` you can bind to entity fields, shader
  uniforms, camera scalars, or anything numeric.

> Documents @vectojs/animation@0.1.3.

## Documentation

- [Animation reference](https://vectojs.org/reference/animation/)
- [Physics & animation guide](https://vectojs.org/learn/physics-engine/)
- [Entity animation surface](https://vectojs.org/reference/core-entity/)
