# @vectojs/math

Standalone spatial and physics math utilities for [VectoJS](https://github.com/vectojs/vectojs).

Extracted from `@vectojs/core` so they can be consumed without pulling in the
scene-graph runtime. `@vectojs/core` re-exports everything here for backward
compatibility.

## Exports

- `SpatialHashGrid` — uniform-grid broad-phase for fast neighbor / hit queries.
- `SpringPhysics` — critically-dampable spring integrator for animated values.

## Install

```sh
bun add @vectojs/math
```

## Usage

```ts
import { SpatialHashGrid, SpringPhysics } from '@vectojs/math';
```
