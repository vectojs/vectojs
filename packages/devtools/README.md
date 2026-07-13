# @vectojs/devtools

> Inspect, audit, trace, snapshot, and debug a live VectoJS Virtual Math Tree.

`@vectojs/devtools` provides both a Canvas-native in-page inspector and framework-neutral headless
primitives for tests, automation, and production diagnostics.

## Install

```bash
bun add -d @vectojs/core @vectojs/devtools
```

The visual panel also requires `@vectojs/ui`. Headless consumers do not:

```bash
bun add -d @vectojs/ui
```

## Headless diagnostics

Use the focused entry when an application needs audits, pointer/keyboard routing traces, scene
snapshots, entity inspection, or pixel picking without bundling the visual panel:

```ts
import { auditScene, captureSnapshot, createEventTrace } from '@vectojs/devtools/headless';

const findings = auditScene(scene);
const snapshot = captureSnapshot(scene);
const trace = createEventTrace(scene, { capacity: 100 });

// Later: trace.entries is JSON-safe and ordered from oldest to newest.
trace.destroy();
```

Each event records its routing surface as `source: "canvas"`, `"a11y"`, `"content"`, or
`"document"`. The `content` source identifies browser input that started on a selectable static-text
projection; `targetId`, `targetPath`, scene/local coordinates, and the finalized `defaultPrevented`
value make shortcut and selection conflicts reproducible without inspecting pixels. Pointer traces
include `pointercancel`, so canceled drag/selection sessions remain diagnosable.

## Visual inspector

Load the panel only in a deliberate debug path so normal users do not download inspector UI:

```ts
if (new URLSearchParams(location.search).has('debug')) {
  const { attachDevtools } = await import('@vectojs/devtools');
  const devtools = attachDevtools(scene, { traceEvents: true });
  // Call devtools.detach() when the debug surface unmounts.
}
```

The panel exposes the live entity tree, geometry, transformed bounds, picking, layout audits,
state snapshots, and recent routed pointer, wheel, and keyboard events.

## Entry points

| Import                       | Responsibility                                             |
| ---------------------------- | ---------------------------------------------------------- |
| `@vectojs/devtools`          | Visual panel plus all headless exports                     |
| `@vectojs/devtools/headless` | Audits, traces, snapshots, inspection, models, and picking |

## License

[MIT](https://github.com/vectojs/vectojs/blob/main/LICENSE) © 2026 Xuepoo
