# VectoUI

> A Zero-DOM, Canvas-native UI **runtime** — render like a game engine, stay drivable like the DOM.

[![CI](https://github.com/Xuepoo/vecto-ui/actions/workflows/ci.yml/badge.svg)](https://github.com/Xuepoo/vecto-ui/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![@vecto-ui/core](https://img.shields.io/npm/v/@vecto-ui/core?label=%40vecto-ui%2Fcore)](https://www.npmjs.com/package/@vecto-ui/core)
[![@vecto-ui/ui](https://img.shields.io/npm/v/@vecto-ui/ui?label=%40vecto-ui%2Fui)](https://www.npmjs.com/package/@vecto-ui/ui)

VectoUI renders an entire UI onto a single `<canvas>` — layout, hit-testing, animation and
physics are pure math on a Virtual Math Tree (VMT), with **no per-element DOM, no reflow, no
style recalc**. It is a _rendering runtime_ (think Flutter/Pixi/Konva), **not** a component
library like shadcn or Ant Design.

### What makes it different: the a11y / agent moat

Canvas UIs have always had one fatal flaw — they're invisible to screen readers and impossible
to automate. VectoUI's headline feature is a thin **semantic shadow layer (`a11yRoot`)**: every
interactive component projects a real, transparent DOM node (`<button>`, `<a>`, `<input>`…)
positioned over the canvas. So a pure-canvas page is:

- **Accessible** — operable by assistive tech, by role and label.
- **Agent-drivable** — Playwright / AI agents can `getByRole(...).click()/.fill()` it natively.
- **Real-input capable** — the canvas `Input` mirrors a real `<input>`, so **CJK IME
  composition**, selection, clipboard and undo all work, drawn on canvas.

It grew out of [vectomancy](https://vectomancy.xuepoo.xyz) (image/text/video → math equations)
and [xuepoo.xyz](https://xuepoo.xyz) (a near-Zero-DOM site whose `<body>` is one interactive canvas).

## Measured performance

Honest, reproducible numbers — no fabricated comparisons. Reproduce the entity benchmark with
`bun run benchmark` (headless Chrome, Canvas 2D, simple filled-circle entities). It runs vsync-capped
by default (CI/sandbox-safe; reports whether N sustains 60 fps); add `--uncapped` for the true
sub-16 ms per-frame cost in the table below. Numbers are per-machine and complexity-dependent.

| Entities | all on-screen   | mostly off-screen (culled) | static, idle (`onDemand`) |
| -------- | --------------- | -------------------------- | ------------------------- |
| 1,000    | ~4 ms (240 fps) | ~2.4 ms (410 fps)          | ~0 (frame cost ⟂ N)       |
| 10,000   | ~19 ms (52 fps) | **~16 ms (63 fps ✅)**     | ~0 (frame cost ⟂ N)       |
| 100,000  | ~156 ms (6 fps) | ~137 ms (7 fps)            | **~0 (frame cost ⟂ N)**   |

- **Viewport culling** (`getBounds()` per entity): off-screen entities are skipped — a 10k
  off-screen-heavy scene holds 60 FPS.
- **On-demand redraw** (`scene.renderMode = 'onDemand'` + `markDirty()`): a static scene renders
  once then idles, so a 100k-entity UI costs the same as an empty one when nothing changes.
- **WebGL2 point layer** (`new Scene(canvas, { pointBackend: 'webgl' })`): batch-circle entities
  render in one draw call — 100k points 7→25 fps (software GL); 1M feasible.
- **Cold/hot text layout**: `LayoutEngine.prepare()` measures once; `layoutPrepared()` re-wraps on
  resize with no re-measurement — ~3.5× faster reflow.
- **vs DOM** (`bun run compare:dom`, CDP metrics): VectoUI keeps a flat ~29 DOM nodes with **0
  layout / 0 style-recalc** while animating; the `Magnetic Type` demo runs 62 animated glyphs at
  60 fps with **a single initial layout and zero reflow during interaction**.

> Not magic everywhere: 100k entities _fully on-screen_ in Canvas 2D is ~6 fps (per-draw-call
> bound — use the WebGL layer). And document-style, selectable, SEO-heavy text is the DOM's home
> turf. See [where it fits](#where-it-fits) below.

## Packages

| Package           | Status  | Description                                                                                    |
| ----------------- | ------- | ---------------------------------------------------------------------------------------------- |
| `@vecto-ui/core`  | Active  | ECS engine, LayoutEngine (cold/hot), SpatialHashGrid, a11y shadow, Canvas2D + WebGL2 renderers |
| `@vecto-ui/ui`    | Active  | High-level components (Text, Button, Link, Image, Card, Stack, Input, Checkbox, Toggle)        |
| `@vecto-ui/three` | Planned | WebGL / Three.js adapter                                                                       |

## Install

```bash
bun add @vecto-ui/core            # core engine
bun add @vecto-ui/ui @vecto-ui/core   # + high-level components
```

## Quick start

**Core — your own entity:**

```typescript
import { Scene, Entity, IRenderer } from '@vecto-ui/core';

class CircleEntity extends Entity {
  isPointInside(x: number, y: number) {
    return Math.hypot(x - this.x, y - this.y) < 50;
  }
  render(r: IRenderer) {
    r.beginPath();
    r.arc(0, 0, 50, 0, Math.PI * 2);
    r.fill('#38bdf8');
  }
}

const scene = new Scene(document.querySelector('canvas')!);
scene.add(new CircleEntity().setPosition(100, 100));
scene.start();
```

**UI — accessible, agent-drivable components:**

```typescript
import { Scene } from '@vecto-ui/core';
import { Stack, Text, Input, Checkbox, Button } from '@vecto-ui/ui';

const scene = new Scene(document.querySelector('canvas')!);
const form = new Stack({ gap: 12 }).setPosition(40, 40);
form.add(new Text('Sign up', { font: '600 24px sans-serif' }));
form.add(new Input({ width: 280, placeholder: 'you@example.com' })); // real <input>, IME-ready
form.add(new Checkbox({ label: 'I accept the terms' }));
form.add(new Button('Create account', { onClick: () => console.log('submit') }));
scene.add(form);
scene.start();
// A screen reader — or Playwright: page.getByRole('textbox').fill('a@b.com') — drives it.
```

## Demos

```bash
bun install
bun run dev   # Vite dev server for apps/demo
```

Open `http://localhost:5173/` and pick a demo from the top nav (or via URL hash):

- `#magnetic-type` — **Magnetic Type**: every glyph is a math entity; the cursor repels them and
  they spring back, with per-glyph hit-testing. 60 fps, zero reflow.
- `#ui-gallery` — the component set with a live, agent-drivable sign-up form.
- `#webgl-points` — 100k+ GPU points/rects in one draw call.
- `#spline` — native vectomancy `Spline` (math-curve) rendering with curve-accurate hit-testing.

## Where it fits

**Plays to its strengths:** infinite canvases / node editors, 100k-point dataviz, data grids,
log/trace viewers, orderbook terminals, whiteboards, timelines — anywhere element count explodes
or you need per-glyph / per-curve interaction; and any page that must be **agent- and AT-drivable
while being pure canvas**.

**Not the right tool for:** document-style, text-heavy, selectable/SEO content (the DOM wins);
deepest text correctness (bidi/complex shaping — pretext/HarfBuzz go further); tiny static UIs
where the DOM's zero setup wins.

## Development

```bash
bun install
bun run dev                       # demo dev server
cd packages/core && bunx vitest run   # core tests
cd packages/ui   && bunx vitest run   # ui tests
bun run lint                      # oxlint
```

## License

MIT © 2026 Xuepoo
