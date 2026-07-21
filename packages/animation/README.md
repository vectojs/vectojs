# @vectojs/animation

Standalone animation drivers and easing functions for [VectoJS](https://github.com/vectojs/vectojs).

Renderer-agnostic value animation: a shared easing library plus tween and spring
drivers. Depends only on `@vectojs/math` (for the spring integrator), so it can
drive any numeric value without the scene graph.

`@vectojs/core` re-exports everything here for backward compatibility.

## Exports

- `Easing` — named easing functions (`EasingName`, `EasingFn`).
- `TweenDriver` — duration + easing based value driver.
- `SpringDriver` — spring-physics based value driver.

## Install

```sh
bun add @vectojs/animation
```

## Usage

```ts
import { TweenDriver, SpringDriver, Easing } from '@vectojs/animation';
```
