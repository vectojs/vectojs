<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://cdn.vectojs.org/brand/vectojs-logo-dark.svg">
    <img src="https://cdn.vectojs.org/brand/vectojs-logo-light.svg" alt="VectoJS" width="380">
  </picture>
</p>

<h1 align="center">VectoJS</h1>

<p align="center">
  <em>A canvas-native UI runtime: render like a scene engine, remain operable like the DOM.</em>
</p>

<p align="center">
  <a href="https://github.com/vectojs/vectojs/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/vectojs/vectojs/actions/workflows/ci.yml/badge.svg"></a>
  <a href="./LICENSE"><img alt="MIT license" src="https://img.shields.io/badge/license-MIT-6366f1.svg"></a>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@vectojs/core"><img alt="core" src="https://img.shields.io/npm/v/@vectojs/core?label=core&color=22d3ee"></a>
  <a href="https://www.npmjs.com/package/@vectojs/ui"><img alt="ui" src="https://img.shields.io/npm/v/@vectojs/ui?label=ui&color=22d3ee"></a>
  <a href="https://www.npmjs.com/package/@vectojs/text"><img alt="text" src="https://img.shields.io/npm/v/@vectojs/text?label=text&color=22d3ee"></a>
  <a href="https://www.npmjs.com/package/@vectojs/layout"><img alt="layout" src="https://img.shields.io/npm/v/@vectojs/layout?label=layout&color=22d3ee"></a>
  <a href="https://www.npmjs.com/package/@vectojs/math"><img alt="math" src="https://img.shields.io/npm/v/@vectojs/math?label=math&color=22d3ee"></a>
  <a href="https://www.npmjs.com/package/@vectojs/animation"><img alt="animation" src="https://img.shields.io/npm/v/@vectojs/animation?label=animation&color=22d3ee"></a>
  <a href="https://www.npmjs.com/package/@vectojs/tex"><img alt="tex" src="https://img.shields.io/npm/v/@vectojs/tex?label=tex&color=22d3ee"></a>
  <a href="https://www.npmjs.com/package/@vectojs/markdown"><img alt="markdown" src="https://img.shields.io/npm/v/@vectojs/markdown?label=markdown&color=22d3ee"></a>
  <a href="https://www.npmjs.com/package/@vectojs/markdown-app"><img alt="markdown-app" src="https://img.shields.io/npm/v/@vectojs/markdown-app?label=markdown-app&color=22d3ee"></a>
  <a href="https://www.npmjs.com/package/@vectojs/three"><img alt="three" src="https://img.shields.io/npm/v/@vectojs/three?label=three&color=22d3ee"></a>
  <a href="https://www.npmjs.com/package/@vectojs/devtools"><img alt="devtools" src="https://img.shields.io/npm/v/@vectojs/devtools?label=devtools&color=22d3ee"></a>
  <a href="https://www.npmjs.com/package/@vectojs/graph3d"><img alt="graph3d" src="https://img.shields.io/npm/v/@vectojs/graph3d?label=graph3d&color=22d3ee"></a>
  <a href="https://www.npmjs.com/package/@vectojs/video-exporter"><img alt="video-exporter" src="https://img.shields.io/npm/v/@vectojs/video-exporter?label=video-exporter&color=22d3ee"></a>
  <a href="https://www.npmjs.com/package/@vectojs/desktop"><img alt="desktop" src="https://img.shields.io/npm/v/@vectojs/desktop?label=desktop&color=22d3ee"></a>
  <a href="https://www.npmjs.com/package/@vectojs/knowledge-graph"><img alt="knowledge-graph" src="https://img.shields.io/npm/v/@vectojs/knowledge-graph?label=knowledge-graph&color=22d3ee"></a>
  <a href="https://www.npmjs.com/package/@vectojs/node-editor"><img alt="node-editor" src="https://img.shields.io/npm/v/@vectojs/node-editor?label=node-editor&color=22d3ee"></a>
  <a href="https://www.npmjs.com/package/@vectojs/table"><img alt="table" src="https://img.shields.io/npm/v/@vectojs/table?label=table&color=22d3ee"></a>
</p>

> Render only what is visible, materialize only what is usable, retain only what is necessary.

VectoJS draws a scene graph onto one `<canvas>`. Layout, hit-testing, animation, text flow, and
render scheduling operate on a Virtual Math Tree (VMT), while interactive entities project a thin
semantic DOM layer for accessibility and automation.

This is not an ECS and it does not claim allocation-free rendering. It is a retained-mode rendering
runtime for interfaces whose visual or interactive complexity is a poor fit for one DOM element per
shape, glyph, point, or row.

[Documentation](https://vectojs.org/learn/introduction/) ·
[Gallery](https://gallery.vectojs.org/) ·
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

| Package                                                  | Purpose                                                                                                                        |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| [`@vectojs/core`](./packages/core)                       | Scene/Entity runtime, events, hit-testing, accessibility projection, Canvas/WebGL/WebGPU support; re-exports the engines below |
| [`@vectojs/text`](./packages/text)                       | Standalone text-shaping primitives: BiDi, Arabic shaping, CSS-parity typography, MSDF fonts, prepared content grids            |
| [`@vectojs/layout`](./packages/layout)                   | Standalone layout engine: line breaking, BiDi-aware inline layout, exclusion flow, off-thread layout worker                    |
| [`@vectojs/math`](./packages/math)                       | Standalone spatial/physics math: spatial hash grid broad-phase and spring physics                                              |
| [`@vectojs/animation`](./packages/animation)             | Standalone easing library plus tween and spring value drivers                                                                  |
| [`@vectojs/tex`](./packages/tex)                         | Zero-DOM TeX math typesetting: a vendored KaTeX parse/layout kernel plus a self-contained SVG emit layer                       |
| [`@vectojs/ui`](./packages/ui)                           | Canvas-native layout, form, content, data, navigation, and overlay components                                                  |
| [`@vectojs/markdown`](./packages/markdown)               | Markdown + TeX-math rendering entity (`Markdown`, `CodeBlock`) built on `@vectojs/ui`, with `marked` + `@vectojs/tex`          |
| [`@vectojs/markdown-app`](./packages/markdown-app)       | Standalone canvas-native Markdown reader and source workbench; composes `@vectojs/markdown` without `@vectojs/desktop`         |
| [`@vectojs/node-editor`](./packages/node-editor)         | Standalone canvas-native node and link editor with typed ports, undoable commands, persistence, and deterministic auto-layout  |
| [`@vectojs/table`](./packages/table)                     | Standalone canvas-native accessible data table with virtualization, keyboard navigation, and selectable cell projections       |
| [`@vectojs/three`](./packages/three)                     | Project a VectoJS scene onto a Three.js texture and route raycast/XR input back into 2D                                        |
| [`@vectojs/devtools`](./packages/devtools)               | In-page Virtual Math Tree inspector plus a headless audit/snapshot layer for tests and CI                                      |
| [`@vectojs/graph3d`](./packages/graph3d)                 | 3D force-directed graph rendering on instanced Three.js, with an in-house dependency-free Barnes-Hut layout                    |
| [`@vectojs/video-exporter`](./packages/video-exporter)   | Fixed-step Chromium + FFmpeg H.264 MP4 export for local modules or hosted scenes                                               |
| [`@vectojs/desktop`](./packages/desktop)                 | Desktop-environment runtime: window manager, taskbar, start menu, shortcut router, display layout, app registry, memory VFS    |
| [`@vectojs/knowledge-graph`](./packages/knowledge-graph) | 2D interactive knowledge-graph viewport: d3-force layout, camera pan/zoom, minimap, hover/filter, on-demand rendering          |

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
  <img src="https://cdn.vectojs.org/assets/architecture.svg" alt="VectoJS Architecture">
</p>

The DOM projection is deliberately not the visual renderer. It carries semantics and native input;
the canvas remains the source of visible pixels.

## Deep dive

`docs/deep-dive` (`vectojs.org/learn/deep-dive/`) walks the whole runtime boss by boss — selection, text layout, semantic projection, streaming Markdown, TeX, VMT, renderers, WASM, Three/XR, video export, graph layout, devtools, styles, responsive, and vertical apps. Each file is one boss; [`00 — Overview`](docs/deep-dive/00-overview.md) is the map with the package graph and a difficulty table.

Published mirrors: [`vectojs-docs/content/learn/deep-dive`](https://github.com/vectojs/vectojs-docs/tree/main/content/learn/deep-dive) (authoritative) and [`vectojs-website/content/learn/deep-dive`](https://github.com/vectojs/vectojs-website/tree/main/content/learn/deep-dive) (`https://vectojs.org/learn/deep-dive/`). Translations land under `content/<locale>/learn/deep-dive/` (see `vectojs-i18n` skill).

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
4. Pointer input arrives through the semantic layer: the projected shadow elements carry
   `pointerdown/move/up`, `click`, and `dblclick` into capture/bubble dispatch on the entity tree
   (the canvas itself only tracks the pointer position). Entities without a materialized shadow
   node (`a11yProjection: 'never'`, or `'onDemand'` before engagement) receive no pointer events;
   canvas hit-testing (`scene.findEntityAt`) is a query API, not a dispatch path.
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

The same diagnostics are available without the panel through
`@vectojs/devtools/headless` — scene audits, pointer/keyboard event traces,
snapshot diffing, dirty-frame attribution, and hit-test explanation — so tests
and automation can use them without bundling `@vectojs/ui`.

## Agent skills

The [vectojs-skills](https://github.com/vectojs/vectojs-skills) repository packages Claude/agent
skills that teach coding agents the VectoJS paradigm — most importantly
`vectojs-paradigm`, which replaces HTML/CSS instincts with scene-graph thinking and a
state-space debugging ladder (inspect numbers and `getA11yTree()` before reaching for
screenshots). Skills also cover the core runtime, responsive layout, UI/animation, performance,
Three.js embedding, the devtools inspector, 3D force-directed graphs, 2D knowledge graphs, and
the video exporter.
Install them into `.claude/skills` or `.agents/skills` of any project that uses VectoJS.

## Demos

Three separate repositories host live, source-available demos.
[vectojs-gallery](https://github.com/vectojs/vectojs-gallery) — itself rendered entirely on one
canvas — is the showcase at [gallery.vectojs.org](https://gallery.vectojs.org):

- **Canvas Studio** — a Fabric.js-style editor: oriented resize handles, band-select, group-move,
  z-reorder, and JSON round-tripping;
- **Nexus** — tens of thousands of particles on a WebGPU compute pass, with a CPU fallback;
- **Stream Reader** — streaming Markdown with off-main-thread lexing, math, tables, and code;
- **Dimension** — a VectoJS panel raycast into a Three.js scene;
- **Pretext, Rebuilt** — nine text-layout demos plus a measured head-to-head;
- **Fruit Catch** — game-style pointer and keyboard interaction.

[vectojs-website](https://github.com/vectojs/vectojs-website) hosts the documentation plus the
danmaku stress test (thousands of individually interactive, accessible comments) and a
canvas-rendered Pool CAPTCHA.

[vectojs-webos](https://github.com/vectojs/webos) is a full desktop environment — windows,
taskbar, start menu, ten built-in apps — built on `@vectojs/desktop`, live at
[webos.vectojs.org](https://webos.vectojs.org) and intended as the seed for a
`create-webos` scaffold.

Performance depends on renderer, entity shape, text, hardware, and workload. Use the checked-in
benchmarks instead of treating demo counts as universal guarantees.

## Development and verification

```bash
bun install
just verify          # = just check + just test (the pre-push habit)
```

`just check` is the same gate CI runs: `oxfmt --check` (formatting authority),
`oxlint --deny-warnings`, `markdownlint-cli2`, `shellcheck`/`shfmt`, and
`actionlint`. Individual recipes are available too — run `just --list` to see
them all:

```bash
just fmt             # format in place (oxfmt)
just test-pkg core   # one package's unit tests
just wasm            # build the Rust wasm core
just e2e             # real-browser e2e (HiDPI + text projection)
```

Additional reproducible workloads:

```bash
./benchmarks/run-browsers.sh      # headed, real GPU — the only quotable numbers
./comparisons/run-browsers.sh     # head-to-head against other libraries
bun run benchmark                 # headless CI tripwire, not quotable
bun run compare:dom               # CDP layout/style/heap comparison (headless)
bun run compare                   # text-layout comparison (headless)
```

`--viewport WxH` on `benchmarks/run-browsers.sh` requests the browser's native
outer-window size. It is passed to Chromium as `--window-size` and to Firefox as
`--width`/`--height`; it is not a CSS content-viewport setter. Browser chrome and
Hyprland decorations therefore consume engine-specific space. For example, a
`--viewport 1280x720` request can produce different `window.innerWidth` and
`window.innerHeight` values in Chrome and Firefox. The actual CSS content viewport
used by the benchmark is recorded in each result's top-level `viewport` object,
alongside `dpr` and `rasterPixels`; use that object when comparing the workload.

Only the two headed runners produce figures that may be quoted. `bun run
benchmark` is headless with `--disable-gpu`, so it measures software
rasterization in a throttled tab: it is a same-environment regression tripwire,
not a statement about a user's machine. Raw baselines live in the docs
repository under `forge/baselines/`.

The project is pre-1.0. Read package changelogs before upgrading and pin versions in production.

## License

[MIT](./LICENSE) © 2026 Xuepoo
