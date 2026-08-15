# @vectojs/desktop

WebOS desktop shell for VectoJS — Plasma-inspired window manager, taskbar,
Kickoff start menu, config-first chrome, VFS, and shortcuts on a single `Scene`.

## Install

```bash
bun add @vectojs/desktop @vectojs/core @vectojs/ui @vectojs/styles
```

## Quick start

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
        icon: 'ℹ',
        create: () => new Text('Hello from @vectojs/desktop'),
      },
      {
        id: 'notes',
        title: 'Notes',
        instances: 'multiple', // KWin: allow many windows
        create: (ctx) => new Text(`note ${ctx.windowId}`),
      },
    ],
    desktop: {
      wallpaper: '#0b1220',
      // wallpaperImage: '/wall.png',
      taskbarHeight: 40,
      taskbarPosition: 'bottom',
      // displays: [{ id: 'main', x: 0, y: 0, width: 1280, height: 800 }],
    },
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

## Plasma-aligned behaviour

| Surface       | Behaviour                                                                  |
| ------------- | -------------------------------------------------------------------------- |
| Window chrome | Titlebar drag, min / max / close (LTR order), edge+corner resize           |
| Keyboard move | Tab to the titlebar handle, arrow keys move the window (Shift = 1px steps) |
| Resize        | 6px rim hit zone on the frame; corner grips drawn while focused            |
| Maximize      | Fills display **work area** (display minus taskbar); double-click titlebar |
| Minimize      | Hides window; taskbar entry restores                                       |
| Task Manager  | One entry per window; click active → minimize; click other → focus         |
| Kickoff       | Start button opens app list panel                                          |
| Multi-display | Logical rectangles in one Scene; per-display work areas                    |
| Shortcuts     | Document-level chord router (`Control+n`, `Meta+w`, …)                     |
| VFS           | Pluggable `Vfs` + in-memory `MemoryVfs`                                    |
| Instances     | `single` (default) focuses existing; `multiple` always spawns              |
| a11y          | Windows default to `a11yProjection: 'onDemand'`                            |

## Public surface

`DesktopShell`, `WindowManager`, `DesktopWindow`, `Taskbar`, `StartMenu`,
`AppRegistry`, `DisplayLayout`, `ShortcutRouter`, `MemoryVfs` / `Vfs`,
`resolveConfig`, `WebosConfig`.

## Design rules

- **Acyclic deps**: `desktop → {core, ui, styles}` only.
- **Config-first**: colours, apps, displays, shortcuts, VFS via `WebosConfig`.
- **Window = Entity**: chrome is 100% canvas; z-order is overlay sibling order.
