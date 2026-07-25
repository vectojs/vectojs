// Interactive real-hardware check for Table virtualization: a 5000-row table in
// a 400px viewport. We drive wheel events and screenshot before/after to prove
// scrolling mounts a different row window (the rows visible change), and that
// only a viewport-worth of body cells is ever mounted.
import { Scene } from '@vectojs/core';
import { Table } from '@vectojs/ui';

const canvas = document.getElementById('c') as HTMLCanvasElement;
const scene = new Scene(canvas);

const table = new Table({
  headers: ['Row', 'Name', 'Score', 'Tag'],
  rows: Array.from({ length: 5000 }, (_, i) => [
    `#${i}`,
    `Item ${i}`,
    `${(i * 37) % 1000}`,
    `tag-${i % 12}`,
  ]),
  width: 560,
  rowHeight: 32,
  viewportHeight: 400,
});
table.setPosition(20, 20);
scene.add(table);
scene.start();

const mountedRows = () => [...((table as any).mountedRows as Set<number>)].sort((a, b) => a - b);

// A DOM banner under the table reports which body rows are currently mounted,
// so a screenshot proves the window moved after scrolling.
const banner = document.createElement('div');
banner.style.cssText =
  'position:absolute;left:20px;top:440px;font:14px monospace;color:#9fe;white-space:pre;';
document.body.appendChild(banner);
const refresh = () => {
  const m = mountedRows();
  banner.textContent = `mounted body rows: ${m.length}  (first #${m[0]} … last #${m[m.length - 1]}) of 5000`;
};

// Scroll driver (also callable manually as window.__scrollTable).
(window as any).__scrollTable = (dy: number) => {
  table.emit('wheel', { deltaY: dy, preventDefault() {} });
  for (let i = 0; i < 240; i++) table.update(16, i * 16); // settle integrator
  scene.markDirty();
  refresh();
  return mountedRows();
};

refresh();
// Auto-scroll ~1500px (≈47 rows) after load so the harness screenshot captures
// a DIFFERENT row window than the top — visible proof scrolling works.
setTimeout(() => (window as any).__scrollTable(1500), 400);
setInterval(refresh, 100);
