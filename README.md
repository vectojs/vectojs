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

## Packages

| Package           | Status | Description                                                                                                                                                                                                                       |
| ----------------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@vecto-ui/core`  | Active | ECS engine, LayoutEngine (cold/hot + paragraph memo), MSDF GPU text, off-thread Web Worker layout, SpatialHashGrid, a11y shadow, Canvas2D + WebGL2 + WebGPU compute-driven particle system (WGSL compute + procedural rendering)  |
| `@vecto-ui/ui`    | Active | High-level components: Text, RichText (inline styles/links/exclusion flow/streaming), Markdown (streaming), Button, Link, Image, Card, Stack, Flow, Input, TextArea, Checkbox, Toggle, ScrollView, Table, Dropdown, Slider, Modal |
| `@vecto-ui/three` | Active | WebGL/Three.js 3D/WebXR space adapter — projects Vecto 2D canvas to 3D mesh texture, translates raycast intersects to 2D event routing, and manages XR pointers & hover boundaries                                                |

## Documentation

Explore our comprehensive tutorials, guidebooks, and API references:
👉 **[Official VectoUI Documentation Portal](https://vecto-ui.xuepoo.xyz/learn/introduction/)**

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

Demos live in their own open-source repo so this one stays the lean engine — clone it to run
them locally, or browse the deployed gallery:

- **Repo & live gallery**: [vecto-website](https://github.com/Xuepoo/vecto-website) → https://vecto-ui.xuepoo.xyz
- Planned showcases: magnetic type, infinite canvas / node editor, Bilibili-style danmaku,
  knowledge-graph viewer, LLM streaming-output rendering, and 100k-point data visualization.

Each demo doubles as a real-world stress test for the engine.

## Where it fits

**Plays to its strengths:** infinite canvases / node editors, 100k-point dataviz, data grids,
log/trace viewers, orderbook terminals, whiteboards, timelines — anywhere element count explodes
or you need per-glyph / per-curve interaction; and any page that must be **agent- and AT-drivable
while being pure canvas**.

**Not the right tool for:** document-style, text-heavy, selectable/SEO content (the DOM wins);
deepest text correctness (bidi/complex shaping — pretext/HarfBuzz go further); tiny static UIs
where the DOM's zero setup wins.

## Testing & quality

VectoUI is validated across many dimensions — this is deliberate: reproducible data, not
reputation, is the case for the engine. Every number above comes from a script in this repo.

| Dimension            | How                                                    | Where                                    |
| -------------------- | ------------------------------------------------------ | ---------------------------------------- |
| Unit / integration   | Vitest (jsdom), core + ui                              | `packages/*/test`                        |
| a11y / automation    | role/name/state contract; driven via shadow nodes      | `packages/ui/test/a11y-contract.test.ts` |
| Stress / leak        | 50k–100k entities, churn, teardown                     | `packages/core/test/stress.test.ts`      |
| Render benchmark     | headless Chrome, real frame-time at 1k/10k/100k        | `bun run benchmark`                      |
| vs DOM (CDP)         | layout-count / style-recalc / heap while animating     | `bun run compare:dom`                    |
| Text-layout accuracy | line-break + glyph positions vs ground truth / pretext | `bun run compare`                        |

```bash
bun install
bun run test                      # core + ui suites
bun run lint                      # oxlint
bun run benchmark                 # real frame-time numbers (headless Chrome)
bun run compare:dom               # CDP layout/heap vs DOM
```

## License

MIT © 2026 Xuepoo
