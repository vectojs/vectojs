# @vectojs/table

> A focused package for VectoJS's canvas-native, accessible data table.

`Table` paints its chrome and cell content on canvas while projecting semantic
`grid`, `row`, `columnheader`, and `gridcell` roles for accessibility and
automation. It includes fixed-height virtualization, roving grid keyboard
semantics, selectable cell projections, streaming `appendRows`, proportional
width changes, and variable-height classic layout.

## Install

```bash
bun add @vectojs/core @vectojs/ui @vectojs/table
```

Both `@vectojs/core` and `@vectojs/ui` are peer dependencies and must be
installed explicitly.

## Usage

```ts
import { Scene } from '@vectojs/core';
import { Table } from '@vectojs/table';

const canvas = document.querySelector<HTMLCanvasElement>('canvas')!;
const scene = new Scene(canvas);
const table = new Table({
  headers: ['Name', 'Status'],
  rows: [
    ['Build', 'Passing'],
    ['Deploy', 'Queued'],
  ],
  width: 480,
});

scene.add(table.setPosition(24, 24));
scene.start();
```

Use `viewportHeight` to mount only visible body rows for large datasets:

```ts
const table = new Table({
  headers: ['ID', 'Value'],
  rows,
  width: 640,
  viewportHeight: 420,
  rowHeight: 36,
});

table.appendRows(nextRows);
```

The implementation is shared with `@vectojs/ui` for compatibility. Existing
`@vectojs/ui` imports continue to work unchanged.

## License

[MIT](https://github.com/vectojs/vectojs/blob/main/LICENSE) © 2026 Xuepoo
