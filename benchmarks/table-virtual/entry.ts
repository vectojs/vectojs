// P2-F table-virtual bench: per-frame cost of a large data Table, virtualized
// (viewportHeight set → only a viewport-worth of cells mounted + projected) vs
// classic (every cell mounted, every row's chrome drawn each frame). We measure
// one settled frame's step() (render walk + a11y/content-projection sync over
// mounted cells), swept over row count. Posts JSON to /results.
import { Scene } from '@vectojs/core';
import { Table } from '@vectojs/ui';

const p = new URLSearchParams(location.search);
// Classic mode mounts EVERY cell (rows × cols entities), so keep the sweep
// bounded — a 50k-row classic table is 200k entities and one full layout()
// already dwarfs the virtualized cost. We measure a single settled frame's
// cost (layout + step), median over a few trials, yielding between cases so
// the page stays responsive.
const ROWS = (p.get('rows') ?? '500,1000,2000,5000').split(',').map(Number);
const TRIALS = Number(p.get('trials') ?? 5);
const VIEWPORT = 600;

const yieldToPaint = () => new Promise((r) => setTimeout(r, 0));

function median(xs: number[]): number {
  xs.sort((a, b) => a - b);
  return xs[Math.floor(xs.length / 2)]!;
}

function makeRows(n: number): string[][] {
  return Array.from({ length: n }, (_, i) => [
    `row ${i}`,
    `value ${i}`,
    `${i * 7}`,
    `tag-${i % 20}`,
  ]);
}

function makeScene(): Scene {
  const canvas = document.createElement('canvas');
  document.body.appendChild(canvas);
  const scene = new Scene(canvas);
  (scene as unknown as { isRunning: boolean }).isRunning = true;
  return scene;
}

function bench(rows: string[][], virtualized: boolean): number {
  const scene = makeScene();
  const table = new Table({
    headers: ['Name', 'Value', 'N', 'Tag'],
    rows,
    width: 800,
    rowHeight: 30,
    viewportHeight: virtualized ? VIEWPORT : undefined,
  });
  scene.add(table);
  scene.step(0); // warm: first layout + projection
  const times: number[] = [];
  for (let t = 0; t < TRIALS; t++) {
    const t0 = performance.now();
    // One settled frame: the per-frame layout + render + a11y/content-projection
    // sync cost. Classic pays it over ALL cells; virtualized only the viewport.
    table.layout();
    scene.step(16 * (t + 1));
    times.push(performance.now() - t0);
  }
  scene.destroy();
  return median(times);
}

async function main() {
  const engine = /firefox/i.test(navigator.userAgent) ? 'firefox' : 'chrome';
  const progress = document.createElement('pre');
  document.body.appendChild(progress);
  const rowsRows: Array<Record<string, number>> = [];
  for (const n of ROWS) {
    progress.textContent = `benchmarking ${n} rows…`;
    await yieldToPaint(); // let the page paint the progress line between cases
    const data = makeRows(n);
    const classicMs = bench(data, false);
    await yieldToPaint();
    const virtualMs = bench(data, true);
    rowsRows.push({
      rows: n,
      classicMsPerFrame: +classicMs.toFixed(4),
      virtualizedMsPerFrame: +virtualMs.toFixed(4),
      speedup: +(classicMs / virtualMs).toFixed(1),
    });
  }
  const payload = {
    name: 'table-virtual',
    engine,
    userAgent: navigator.userAgent,
    params: { ROWS, TRIALS, VIEWPORT },
    rows: rowsRows,
  };
  try {
    await fetch('/results', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch {
    // ignore — table still shown below
  }
  progress.textContent = 'done';
  const pre = document.createElement('pre');
  pre.textContent = JSON.stringify(payload, null, 2);
  document.body.appendChild(pre);
}

main();
