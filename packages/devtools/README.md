# @vectojs/devtools

Inspector for the VectoJS Virtual Math Tree, in two halves: a Canvas-native in-page panel (itself rendered with VectoJS) with live tree view, entity picking, state readout, audits, and an event log — and a framework-neutral headless model layer of pure functions that answer layout, accessibility, hit-testing, text, and performance questions as data. The model layer is usable from tests, CI, Node, and agents without any panel code; it peers on `@vectojs/core` alone, while the visual panel additionally uses `@vectojs/ui` (an optional peer).

## Install

```bash
bun add @vectojs/devtools
```

Install as a dev dependency and keep it out of production bundles: import the panel lazily behind a deliberate debug path, and pull the model layer from the `headless` subpath where no `@vectojs/ui` is needed.

## Usage

```ts
import {
  auditScene,
  captureSnapshot,
  createEventTrace,
  pickInScene,
} from '@vectojs/devtools/headless';

const findings = auditScene(scene); // text overflow, out-of-bounds, overlap
const snapshot = captureSnapshot(scene); // JSON-safe tree state for assertions
const trace = createEventTrace(scene, { capacity: 100 });

// Picker parity: same walk order AND acceptance rule as Scene pointer input.
const hit = pickInScene(scene, 120, 80);

// Later: trace.entries is JSON-safe, oldest first, tagged by routing surface
// (canvas | a11y | content | document) with targetId/path and coordinates.
trace.destroy();

// Visual panel: lazy-load it behind a deliberate debug path.
const { attachDevtools } = await import('@vectojs/devtools');
const devtools = attachDevtools(scene, { traceEvents: true });
// devtools.detach() when the debug surface unmounts
```

## Highlights

- ~60 headless exports across audits (`auditScene`, a11y, selection drift, accelerators), snapshots and diffs for regression assertions, event-routing traces, hit-test explanation, highlight geometry, GPU/draw counters, dirty-repaint attribution, text shaping, and Markdown streaming metrics.
- Picker parity with the engine: `findEntityAt`/`pickInScene` use the same walk order and acceptance rule as Scene pointer input, so an entity is picked only where its own shape accepts the point — particles and other non-interactive entities are never false owners.
- Event traces record the routing surface (`canvas`, `a11y`, `content`, or `document`) plus `targetId`, `targetPath`, scene/local coordinates, modifiers, and the finalized `defaultPrevented` value, making shortcut and selection conflicts reproducible without inspecting pixels.
- Pure reads, no side effects: performance inspections report "unmeasured" rather than silently enabling instrumentation; draw counters and phase timing must be switched on first.
- JSON-RPC bridge and plugin protocol let another document drive inspection and add custom tabs, audits, inspectors, and commands (`registerDevtoolsPlugin`).
- The panel is itself an on-demand VectoJS scene with `contentProjection: false`; its dock is `pointer-events: none` except for its own projected controls, so it never steals input from host content underneath empty dock pixels.

> Documents @vectojs/devtools@0.11.2.

## Documentation

- [Overview](https://vectojs.org/reference/devtools/)
- [Inspecting](https://vectojs.org/reference/devtools-inspect/)
- [Auditing](https://vectojs.org/reference/devtools-audit/)
- [Performance](https://vectojs.org/reference/devtools-perf/)
- [Bridge & plugins](https://vectojs.org/reference/devtools-extend/)
