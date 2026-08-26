# @vectojs/desktop

WebOS desktop shell for VectoJS — a Plasma-inspired window manager, taskbar, Kickoff start menu, multi-display work areas, chord shortcuts, and a pluggable VFS composed on a single `Scene`. It sits at the application layer of the package graph: it composes `@vectojs/core`, `@vectojs/ui`, and `@vectojs/styles` behind one config-first shell (`WebosConfig`), so apps register once and get window chrome, focus, minimize/maximize, and keyboard access without touching DOM.

## Install

```bash
bun add @vectojs/desktop
```

`@vectojs/core`, `@vectojs/ui`, and `@vectojs/styles` are peer dependencies and must be installed explicitly.

## Usage

```ts
import { Scene } from '@vectojs/core';
import { Text } from '@vectojs/ui';
import { DesktopShell, MemoryVfs } from '@vectojs/desktop';

const scene = new Scene(canvas, { renderMode: 'onDemand' });
const shell = new DesktopShell({
  scene,
  config: {
    apps: [
      {
        id: 'about',
        title: 'About',
        iconSvg: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" fill="#38bdf8"/></svg>',
        create: () => new Text('Hello from @vectojs/desktop'),
      },
      {
        id: 'notes',
        title: 'Notes',
        instances: 'multiple',
        create: (ctx) => new Text(`note ${ctx.windowId}`),
      },
    ],
    desktop: { wallpaper: '#0b1220', taskbarHeight: 40, taskbarPosition: 'bottom' },
    shortcuts: {
      'Control+n': { type: 'open-app', appId: 'notes' },
      'Meta+w': { type: 'close-focused' },
      'Meta+Space': { type: 'toggle-start' },
    },
    vfs: new MemoryVfs(),
  },
});
shell.start();
shell.open('about');
```

## Highlights

- Window chrome is 100% canvas: titlebar drag, min/max/close, edge and corner resize with a 6px rim hit zone, double-click maximize into the display work area (display minus taskbar), and taskbar-restore minimize.
- Keyboard-first WM behavior: Tab reaches the titlebar handle, arrow keys move the focused window (Shift steps 1px), and windows default to `a11yProjection: 'onDemand'`.
- Multi-display in one Scene: logical display rectangles each with their own work area; maximize respects the containing display.
- Config-first everything — apps, wallpaper, displays, shortcuts, theme tokens, and VFS arrive as one `WebosConfig` resolved by `resolveConfig`.
- Document-level chord router (`Control+n`, `Meta+w`, `Meta+Space`, ...) with `{ type: 'open-app' | 'close-focused' | 'toggle-start' | 'custom' }` actions and a custom handler hook.
- App instance policy per app: `'single'` (default) focuses the existing window; `'multiple'` always spawns, KWin-style.
- Stable SVG icons via `AppDefinition.iconSvg` across Start menu, taskbar, and window chrome; `icon` text remains a legacy fallback.
- Pluggable `Vfs` interface with an in-memory `MemoryVfs`; acyclic dependency rule `desktop → {core, ui, styles}` only.

> Documents @vectojs/desktop@0.7.1.

## Documentation

No dedicated docs page yet — see the [repository](https://github.com/vectojs/vectojs/tree/main/packages/desktop) for source, tests, and the type surface.
