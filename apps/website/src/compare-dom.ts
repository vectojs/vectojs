import { Scene } from '@vecto-ui/core';
import { Text } from '@vecto-ui/ui';

/**
 * Apples-to-apples comparison: render N animated text labels two ways and let the
 * driver (scripts/compare-dom.ts) read browser-side CPU/memory via CDP.
 *
 * - `mode=dom`   — one `<div>` per label (traditional approach).
 * - `mode=vecto` — one VectoUI `Text` entity per label on a single `<canvas>`.
 *
 * Each measured frame mutates every label's text and x-position — the realistic
 * dynamic-UI stress that forces DOM style-recalc + layout + paint, vs a single
 * canvas redraw for VectoUI.
 */
const params = new URLSearchParams(location.search);
const MODE = params.get('mode') ?? 'vecto';
const N = Number(params.get('n') ?? 2000);
const FRAMES = Number(params.get('frames') ?? 120);
const WARMUP = Number(params.get('warmup') ?? 30);
// `work=move` repositions labels each frame (no text change); `work=text` also
// rewrites each label's text (re-layout). move favors canvas; text is VectoUI's
// worst case (per-frame text layout in JS).
const WORK = params.get('work') ?? 'move';

const app = document.getElementById('app')!;
const cols = Math.max(1, Math.ceil(Math.sqrt(N * (window.innerWidth / window.innerHeight))));
const cellW = window.innerWidth / cols;
const rows = Math.ceil(N / cols);
const cellH = window.innerHeight / rows;
const baseLabel = (i: number) => `item ${i}`;

type Updater = (frame: number) => void;
let update: Updater;

if (MODE === 'dom') {
  const frag = document.createDocumentFragment();
  const els: HTMLDivElement[] = [];
  for (let i = 0; i < N; i++) {
    const el = document.createElement('div');
    el.style.cssText = 'position:absolute;font:13px monospace;color:#94a3b8;white-space:nowrap';
    el.style.top = `${Math.floor(i / cols) * cellH}px`;
    el.textContent = baseLabel(i);
    els.push(el);
    frag.appendChild(el);
  }
  app.appendChild(frag);
  update = (frame) => {
    for (let i = 0; i < N; i++) {
      const col = i % cols;
      if (WORK === 'text') els[i].textContent = `${baseLabel(i)}:${frame}`;
      els[i].style.left = `${col * cellW + Math.sin((frame + i) * 0.05) * 6}px`;
    }
  };
} else {
  const canvas = document.createElement('canvas');
  app.appendChild(canvas);
  const scene = new Scene(canvas);
  const labels: Text[] = [];
  for (let i = 0; i < N; i++) {
    const t = new Text(baseLabel(i), { font: '13px monospace', color: '#94a3b8', lineHeight: 16 });
    t.interactive = false; // pure Zero-DOM display text — no shadow node projected
    t.setPosition((i % cols) * cellW, Math.floor(i / cols) * cellH);
    labels.push(t);
    scene.add(t);
  }
  scene.start();
  update = (frame) => {
    for (let i = 0; i < N; i++) {
      if (WORK === 'text') labels[i].setText(`${baseLabel(i)}:${frame}`);
      labels[i].setPosition((i % cols) * cellW + Math.sin((frame + i) * 0.05) * 6, labels[i].y);
    }
  };
}

// Drive a fixed number of frames, timing the measured window.
const samples: number[] = [];
let last = performance.now();
let warmupLeft = WARMUP;
let frame = 0;

function tick(): void {
  const now = performance.now();
  if (warmupLeft > 0) warmupLeft--;
  else samples.push(now - last);
  last = now;

  update(frame++);

  if (samples.length < FRAMES) {
    requestAnimationFrame(tick);
    return;
  }
  const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
  const mem = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
  (window as Window & { __COMPARE__?: unknown; __COMPARE_DONE__?: boolean }).__COMPARE__ = {
    mode: MODE,
    work: WORK,
    n: N,
    domNodes: document.getElementsByTagName('*').length,
    heapMB: mem ? Number((mem.usedJSHeapSize / 1e6).toFixed(1)) : null,
    meanFrameMs: Number(mean.toFixed(2)),
    fps: Number((1000 / mean).toFixed(1)),
  };
  (window as Window & { __COMPARE_DONE__?: boolean }).__COMPARE_DONE__ = true;
}

(window as Window & { __READY__?: boolean }).__READY__ = true;
requestAnimationFrame(() => {
  last = performance.now();
  requestAnimationFrame(tick);
});
