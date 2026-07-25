// Real-hardware selection audit for the virtualized Table: mounted body cells
// are Text entities with content projection, so their text must stay selectable
// with correct DOM-vs-canvas geometry even though the body is clipped + scrolled.
// reportSelectionAudit posts the drift verdict as JSON for drive.sh.
import { Scene } from '@vectojs/core';
import { Table } from '@vectojs/ui';
import { reportSelectionAudit } from '../harness';

const canvas = document.getElementById('c') as HTMLCanvasElement;
const scene = new Scene(canvas);

const table = new Table({
  headers: ['Row', 'Name', 'Score', 'Tag'],
  rows: Array.from({ length: 5000 }, (_, i) => [
    `#${i}`,
    `Selectable item ${i}`,
    `${(i * 37) % 1000}`,
    `tag-${i % 12}`,
  ]),
  width: 560,
  rowHeight: 32,
  viewportHeight: 400,
  selectable: true,
});
table.setPosition(20, 20);
scene.add(table);
scene.start();

// Scroll into the middle of the list so the audit runs against a MOUNTED window
// that isn't row 0 — proving selection geometry is correct for virtualized rows
// at a scrolled, clip-offset position.
table.emit('wheel', { deltaY: 1500, preventDefault() {} });
for (let i = 0; i < 240; i++) table.update(16, i * 16);
scene.markDirty();

setTimeout(() => void reportSelectionAudit(scene), 500);
