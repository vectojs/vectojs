# VectoJS

> A canvas-native UI runtime: render like a scene engine, remain operable like the DOM.

[![CI](https://github.com/vectojs/vectojs/actions/workflows/ci.yml/badge.svg)](https://github.com/vectojs/vectojs/actions/workflows/ci.yml)
[![MIT license](https://img.shields.io/badge/license-MIT-6366f1.svg)](./LICENSE)
[![core](https://img.shields.io/npm/v/@vectojs/core?label=core&color=22d3ee)](https://www.npmjs.com/package/@vectojs/core)
[![ui](https://img.shields.io/npm/v/@vectojs/ui?label=ui&color=22d3ee)](https://www.npmjs.com/package/@vectojs/ui)
[![three](https://img.shields.io/npm/v/@vectojs/three?label=three&color=22d3ee)](https://www.npmjs.com/package/@vectojs/three)
[![devtools](https://img.shields.io/npm/v/@vectojs/devtools?label=devtools&color=22d3ee)](https://www.npmjs.com/package/@vectojs/devtools)
[![video exporter](https://img.shields.io/npm/v/@vectojs/video-exporter?label=video-exporter&color=22d3ee)](https://www.npmjs.com/package/@vectojs/video-exporter)

VectoJS draws a scene graph onto one `<canvas>`. Layout, hit-testing, animation, text flow, and
render scheduling operate on a Virtual Math Tree (VMT), while interactive entities project a thin
semantic DOM layer for accessibility and automation.

This is not an ECS and it does not claim allocation-free rendering. It is a retained-mode rendering
runtime for interfaces whose visual or interactive complexity is a poor fit for one DOM element per
shape, glyph, point, or row.

[Documentation](https://vectojs.org/learn/introduction/) ·
[Live demos](https://vectojs.org/demos/) ·
[Component reference](https://vectojs.org/reference/ui-components/) ·
[Issues](https://github.com/vectojs/vectojs/issues)

## Why VectoJS

- **Canvas-native visuals** — Canvas 2D is the default renderer; WebGL point batching and WebGPU
  compute paths cover high-volume workloads.
- **Semantic projection** — buttons, links, inputs, checkboxes, sliders, and other controls expose
  role/name/state through transparent DOM counterparts.
- **Real browser input** — `Input` and `TextArea` mirror native controls, preserving IME composition,
  selection, clipboard, undo, and automation APIs.
- **Mathematical interaction** — transforms, bounds, spatial hashing, event capture/bubble, clipping,
  and hit-testing live in one coordinate model.
- **Deterministic rendering tools** — on-demand redraw, fixed-step `Scene.step()`, and the video
  exporter support tests, simulations, and offline capture.
- **Framework-neutral** — mount a canvas from React, Vue, Svelte, vanilla TypeScript, or a Three.js
  scene; VectoJS does not own your application state.

## Packages

| Package                                                | Purpose                                                                                                                  |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| [`@vectojs/core`](./packages/core)                     | Scene/Entity runtime, layout and text engine, events, hit-testing, accessibility projection, Canvas/WebGL/WebGPU support |
| [`@vectojs/ui`](./packages/ui)                         | Canvas-native layout, form, content, data, navigation, and overlay components                                            |
| [`@vectojs/three`](./packages/three)                   | Project a VectoJS scene onto a Three.js texture and route raycast/XR input back into 2D                                  |
| [`@vectojs/devtools`](./packages/devtools)             | In-page Virtual Math Tree inspector: entity tree, click-to-pick, live geometry readout and nudging                       |
| [`@vectojs/video-exporter`](./packages/video-exporter) | Fixed-step Chromium + FFmpeg H.264 MP4 export for local modules or hosted scenes                                         |

## Install

```bash
bun add @vectojs/core
bun add @vectojs/ui       # optional high-level components
```

The packages are standard ESM/CJS npm packages and also work with npm, pnpm, and yarn.

## Quick start

```html
<div id="app"><canvas id="canvas"></canvas></div>
<style>
  #app {
    position: relative;
    width: 100vw;
    height: 100vh;
  }
  canvas {
    display: block;
    width: 100%;
    height: 100%;
  }
</style>
```

```ts
import { Scene } from '@vectojs/core';
import { Button, Input, Stack, Text, Toggle } from '@vectojs/ui';

const canvas = document.querySelector<HTMLCanvasElement>('#canvas')!;
const scene = new Scene(canvas, { maxFPS: 60 });
scene.renderMode = 'onDemand';

const panel = new Stack({ direction: 'vertical', gap: 14 });
panel.setPosition(40, 40);
panel.add(new Text('Runtime settings', { font: '700 24px Inter' }));
panel.add(new Input({ width: 280, placeholder: 'Project name' }));
panel.add(new Toggle({ checked: true, label: 'GPU acceleration' }));
panel.add(
  new Button('Save', {
    onClick: () => console.log('saved'),
  }),
);

scene.add(panel);
scene.start();

window.addEventListener('resize', () => {
  scene.resize(window.innerWidth, window.innerHeight);
});

// Release renderers, workers, observers, and projected DOM when unmounting.
// scene.destroy();
```

The visual controls are canvas-rendered. Their semantic counterparts remain discoverable:

```ts
await page.getByRole('textbox', { name: 'Project name' }).fill('Nexus');
await page.getByRole('button', { name: 'Save' }).click();
```

## Architecture

<p align="center">
<svg viewBox="0 0 900 420" xmlns="http://www.w3.org/2000/svg" font-family="Inter, system-ui, sans-serif">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#0b1020"/>
      <stop offset="1" stop-color="#08111d"/>
    </linearGradient>
    <marker id="arrow" markerWidth="10" markerHeight="10" refX="8" refY="5" orient="auto">
      <path d="M0 0 L10 5 L0 10 Z" fill="#38bdf8"/>
    </marker>
  </defs>
  <rect width="900" height="420" rx="24" fill="url(#bg)"/>
  <text x="450" y="44" fill="#94a3b8" font-size="13" font-weight="700" text-anchor="middle" letter-spacing="1.6">VECTOJS ARCHITECTURE</text>
  <g>
    <rect x="48" y="158" width="180" height="72" rx="16" fill="#111827" stroke="#334155"/>
    <text x="138" y="188" fill="#f8fafc" font-size="16" font-weight="900" text-anchor="middle">Application state</text>
    <text x="138" y="211" fill="#94a3b8" font-size="12" text-anchor="middle">plain JS data and intent</text>
    <rect x="334" y="118" width="232" height="152" rx="24" fill="#172554" stroke="#38bdf8" stroke-width="2.5"/>
    <text x="450" y="172" fill="#e0f2fe" font-size="23" font-weight="900" text-anchor="middle">Virtual Math Tree</text>
    <text x="450" y="202" fill="#bfdbfe" font-size="13" text-anchor="middle">entities · transforms · layout</text>
    <text x="450" y="226" fill="#bfdbfe" font-size="13" text-anchor="middle">events · animation · semantics</text>
    <rect x="664" y="74" width="184" height="56" rx="14" fill="#111827" stroke="#334155"/>
    <text x="756" y="107" fill="#f8fafc" font-size="15" font-weight="900" text-anchor="middle">Math layout + text</text>
    <rect x="664" y="148" width="184" height="56" rx="14" fill="#111827" stroke="#334155"/>
    <text x="756" y="181" fill="#f8fafc" font-size="15" font-weight="900" text-anchor="middle">Hit testing + events</text>
    <rect x="664" y="222" width="184" height="56" rx="14" fill="#111827" stroke="#334155"/>
    <text x="756" y="255" fill="#f8fafc" font-size="15" font-weight="900" text-anchor="middle">Canvas / WebGL / WebGPU</text>
    <rect x="664" y="296" width="184" height="56" rx="14" fill="#111827" stroke="#334155"/>
    <text x="756" y="329" fill="#f8fafc" font-size="15" font-weight="900" text-anchor="middle">Semantic DOM projection</text>
  </g>
  <g stroke="#38bdf8" stroke-width="2.4" fill="none" marker-end="url(#arrow)">
    <path d="M228 194 H324"/>
    <path d="M566 159 C606 132 624 108 654 102"/>
    <path d="M566 181 H654"/>
    <path d="M566 213 C604 226 628 242 654 250"/>
    <path d="M524 270 C570 314 612 324 654 324"/>
  </g>
  <g>
    <rect x="246" y="330" width="408" height="44" rx="22" fill="#082f49" stroke="#155e75"/>
    <text x="450" y="358" fill="#a5f3fc" font-size="13" font-weight="800" text-anchor="middle">pixels stay canvas-rendered; accessibility and automation stay semantic</text>
  </g>
</svg>
</p>

The DOM projection is deliberately not the visual renderer. It carries semantics and native input;
the canvas remains the source of visible pixels.

## Where it fits

Good candidates:

- infinite canvases, graphs, timelines, whiteboards, node editors;
- dense dashboards, traces, order books, virtualized data, streaming output;
- particle fields, simulations, educational/diagramming tools;
- 2D panels embedded in Three.js/WebXR;
- interfaces that need both canvas scale and role-based accessibility/automation.

Prefer ordinary HTML/CSS for document-first pages, SEO-heavy prose, native text selection, small
static forms, or applications that do not benefit from a retained scene graph.

## Render and interaction model

1. Add `Entity` instances to a `Scene`.
2. Layout resolves local boxes and transforms.
3. Dirty scenes render through the selected backend.
4. Pointer input is mapped into scene coordinates, spatially queried, then dispatched through
   capture and bubble phases.
5. Interactive entities synchronize role/name/state and native input through the semantic layer.

Read the [core guide](https://vectojs.org/learn/core-scene/) for lifecycle and rendering, and
the [accessibility guide](https://vectojs.org/learn/accessibility/) before shipping controls.

## Devtools

`@vectojs/devtools` ships an in-page VMT inspector — a canvas-rendered panel (dogfooding
`@vectojs/ui`) with the live entity tree, click-to-pick, a selection highlight overlay, geometry
readouts, and arrow-key nudging:

```ts
import { attachDevtools } from '@vectojs/devtools';

const devtools = attachDevtools(scene);
// …
devtools.detach();
```

Tests and production diagnostics can avoid the visual panel and its UI dependency graph:

```ts
import { auditScene, createEventTrace } from '@vectojs/devtools/headless';

const findings = auditScene(scene);
const trace = createEventTrace(scene);
```

## Agent skills

The [vectojs-skills](https://github.com/vectojs/vectojs-skills) repository packages Claude/agent
skills that teach coding agents the VectoJS paradigm — most importantly
`vectojs-paradigm`, which replaces HTML/CSS instincts with scene-graph thinking and a
state-space debugging ladder (inspect numbers and `getA11yTree()` before reaching for
screenshots). Skills also cover the core runtime, responsive layout, UI/animation, performance,
Three.js embedding, and the video exporter. Install them into `.claude/skills` or
`.agents/skills` of any project that uses VectoJS.

## Demos

The separate [vectojs-website](https://github.com/vectojs/vectojs-website) repository hosts live,
source-available stress tests:

- large danmaku streams and WebGPU particle fields;
- streaming Markdown/chat rendering;
- a knowledge graph;
- a VectoJS panel embedded in a Three.js scene;
- game-style pointer and keyboard interaction.

Performance depends on renderer, entity shape, text, hardware, and workload. Use the checked-in
benchmarks instead of treating demo counts as universal guarantees.

## Development and verification

```bash
bun install
bun run build
bun run test
oxlint --deny-warnings .
prettier --check "**/*.{js,ts,json,md,html,yaml}"
knip
```

Additional reproducible workloads:

```bash
bun run benchmark     # real browser frame-time workloads
bun run compare:dom   # CDP layout/style/heap comparison
bun run compare       # text-layout comparison
```

The project is pre-1.0. Read package changelogs before upgrading and pin versions in production.

## License

[MIT](./LICENSE) © 2026 Xuepoo
