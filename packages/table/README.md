# @vectojs/table

Canvas-native, virtualized, accessible data table for VectoJS. `Table` paints its chrome and cell content on canvas while projecting semantic `grid`, `row`, `columnheader`, and `gridcell` roles for accessibility and automation; it pairs fixed-height virtualization with roving grid keyboard semantics, selectable cell projections, streaming `appendRows`, per-column alignment, and a variable-height classic mode. It is the focused home of the table component — also re-exported from `@vectojs/ui` for compatibility — peering only on `@vectojs/core` and `@vectojs/ui`.

## Install

```bash
bun add @vectojs/table
```

`@vectojs/core` and `@vectojs/ui` are peer dependencies and must be installed explicitly.

## Usage

```ts
import { Scene } from '@vectojs/core';
import { Table } from '@vectojs/table';

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

// Large datasets: fix the height, pin the header, mount only visible rows.
const big = new Table({
  headers: ['ID', 'Value'],
  rows,
  width: 640,
  viewportHeight: 420,
  rowHeight: 36,
});
big.appendRows(nextRows); // stream pages in without rebuilding the world
```

## Highlights

- Virtualization is opt-in via `viewportHeight`: body rows outside the viewport (plus overscan) are never mounted or projected, and scroll-to-row stays O(1) because virtualized rows lay out at the fixed `rowHeight`.
- Semantic projection — `grid`/`row`/`columnheader`/`gridcell` — gives screen readers and automation real table structure from canvas pixels.
- Roving grid keyboard semantics over cells, with selectable cell projections.
- Streaming `appendRows` adds pages without quadratic relayout work.
- Per-column alignment (`align`) positions cell blocks within their column; proportional `colWidths` changes reflow the whole grid.
- Omitting `viewportHeight` keeps the classic behavior: the table grows to fit all rows at each row's natural height.

> Documents @vectojs/table@0.1.1.

## Documentation

No dedicated docs page yet — see the [repository](https://github.com/vectojs/vectojs/tree/main/packages/table) for source, tests, and the type surface.
