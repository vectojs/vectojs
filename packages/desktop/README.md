# @vectojs/desktop

WebOS desktop shell for VectoJS — window manager, app registry, and
config-first chrome on a single `Scene`.

> **Status: 0.1.0 skeleton.** WindowManager + AppRegistry + DesktopShell +
> `webos.config` schema. No taskbar, VFS, or `create-webos` yet.

## Install

```bash
bun add @vectojs/desktop @vectojs/core @vectojs/ui @vectojs/styles
```

## Quick start

```ts
import { Scene } from '@vectojs/core';
import { Text } from '@vectojs/ui';
import { DesktopShell } from '@vectojs/desktop';

const scene = new Scene(canvas, { renderMode: 'onDemand' });
const shell = new DesktopShell({
  scene,
  config: {
    apps: [
      {
        id: 'about',
        title: 'About',
        create: () => new Text('Hello from @vectojs/desktop'),
      },
    ],
    theme: {
      'desktop-wallpaper': '#0b1220',
      'desktop-focus-ring': '#38bdf8',
    },
  },
});
shell.start();
shell.open('about');
```

## Design rules

- **Acyclic deps**: `desktop → {core, ui, styles}` only.
- **Config-first**: colours, apps, and shortcuts come from `WebosConfig` —
  never hardcode chrome in the WM.
- **onDemand a11y**: every window defaults to `a11yProjection: 'onDemand'`;
  background windows project nothing until focus / pointer / explicit request.
- **Window = Entity**: chrome is 100% canvas; z-order is overlay sibling order.

## Public surface

| Export          | Role                                      |
| --------------- | ----------------------------------------- |
| `DesktopShell`  | Host: wallpaper, registry, window manager |
| `WindowManager` | open / focus / close / z-order            |
| `DesktopWindow` | Titlebar + client host                    |
| `AppRegistry`   | Installable app catalogue                 |
| `resolveConfig` | Validate + default-merge `WebosConfig`    |
| `WebosConfig`   | Schema type                               |

## Not in 0.1.0

Taskbar, start menu, VFS, keyboard shortcut router, editor apps,
`create-webos` CLI — see vectojs-docs TODO (WebOS flagship phases).
