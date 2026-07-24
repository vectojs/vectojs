// Table surface for the selection harness (CTX-0015): each cell is its own
// selectable Text projection positioned at a column offset, so the risk is a
// cell's selection box drifting from its glyphs — or bleeding across a column
// boundary. The devtools audit walks every cell projection; multi-word cells and
// uneven column widths stress the per-cell origin. `?zoom=` applies CSS zoom.
import { Scene } from '@vectojs/core';
import { Table } from '@vectojs/ui';
import { reportSelectionAudit } from '../harness';

const zoom = Number(new URLSearchParams(location.search).get('zoom') ?? '1');
if (zoom !== 1) document.body.style.zoom = String(zoom);

const canvas = document.getElementById('c') as HTMLCanvasElement;
const scene = new Scene(canvas);

scene.add(
  new Table({
    headers: ['Component', 'Responsibility', 'Qty'],
    rows: [
      ['LayoutEngine', 'line breaking and bidi', '1'],
      ['SpatialHashGrid', 'broad phase hit testing', '42'],
      ['ContentProjection', 'accessible DOM mirror', '7'],
    ],
    width: 620,
    colWidths: [140, 360, 60], // deliberately uneven columns
    selectable: true,
  }).setPosition(20, 20),
);
scene.start();

setTimeout(() => void reportSelectionAudit(scene), 500);
