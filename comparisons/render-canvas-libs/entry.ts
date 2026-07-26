// Rendering comparison: VectoJS vs Konva vs Fabric vs a native DOM baseline.
//
// A throughput number alone would be misleading for these libraries. What
// actually differs — and what only a REAL browser can settle — is:
//
//   1. Is text crisp at DPR > 1? A canvas library that doesn't scale its backing
//      store renders blurry text on every laptop/phone made in the last decade.
//   2. Can the user SELECT and copy the text? Canvas pixels aren't selectable
//      unless the library projects something selectable.
//   3. Is there an accessibility tree? Can `getByRole('button', {name})` — a
//      screen reader, or a Playwright/agent script — find the controls?
//
// The DOM baseline is included deliberately: it's the thing canvas libraries are
// replacing, so it's the reference for "correct" text crispness and selection.
// Source review of `tmp/references/{konva,fabric}` found ZERO `aria-`/`role=`
// occurrences in either library's source; this page verifies that at runtime
// rather than trusting the grep.
import { Scene, Entity } from '@vectojs/core';
import { Button, Text as VText } from '@vectojs/ui';
import Konva from 'konva';
import * as fabric from 'fabric';

const LABEL = 'Selectable label 12345';
const BTN = 'Run export';
const W = 320;
const H = 180;

type Probe = {
  library: string;
  /** Backing-store px per CSS px. 1 at DPR 2 = blurry text. */
  backingStoreRatio: number | null;
  /** Does a role=button node exist that AT / Playwright could resolve? */
  hasAriaTree: boolean;
  roleButtonCount: number;
  accessibleName: string | null;
  /** Is any of the drawn text reachable as selectable DOM text? */
  selectableText: boolean;
  selectedSample: string | null;
  notes: string;
};

const host = (id: string, title: string): HTMLDivElement => {
  const wrap = document.createElement('div');
  wrap.style.cssText = 'margin:12px;display:inline-block;vertical-align:top';
  const h = document.createElement('h3');
  h.textContent = title;
  h.style.cssText = 'font:600 13px sans-serif;margin:0 0 6px';
  const box = document.createElement('div');
  box.id = id;
  box.style.cssText = `width:${W}px;height:${H}px;position:relative;background:#0d1117`;
  wrap.append(h, box);
  document.body.appendChild(wrap);
  return box;
};

/** Drag-select across a box and report what the browser actually selected. */
function trySelect(box: HTMLElement): { ok: boolean; text: string | null } {
  const r = box.getBoundingClientRect();
  const sel = window.getSelection();
  sel?.removeAllRanges();
  // Use a Range over the subtree: this asks "is there selectable text here",
  // which is what a user's drag resolves to.
  const range = document.createRange();
  try {
    range.selectNodeContents(box);
    sel?.addRange(range);
  } catch {
    return { ok: false, text: null };
  }
  const text = sel?.toString().trim() ?? '';
  sel?.removeAllRanges();
  void r;
  return {
    ok: text.length > 0,
    text: text.length > 0 ? text.slice(0, 60) : null,
  };
}

function probeAria(box: HTMLElement) {
  const buttons = box.querySelectorAll('[role="button"], button');
  const first = buttons[0] as HTMLElement | undefined;
  const name = first?.getAttribute('aria-label') ?? first?.textContent?.trim() ?? null;
  return { count: buttons.length, name: name && name.length > 0 ? name : null };
}

function backingRatio(box: HTMLElement): number | null {
  const c = box.querySelector('canvas') as HTMLCanvasElement | null;
  if (!c) return null;
  const cssW = c.getBoundingClientRect().width || parseFloat(c.style.width) || W;
  return cssW > 0 ? +(c.width / cssW).toFixed(2) : null;
}

// ── 1. DOM baseline — what canvas libraries are replacing ────────────────────
function domBaseline(): Probe {
  const box = host('dom', 'DOM (baseline)');
  const p = document.createElement('p');
  p.textContent = LABEL;
  p.style.cssText = 'color:#e6edf3;font:16px sans-serif;margin:16px';
  const b = document.createElement('button');
  b.textContent = BTN;
  b.style.cssText = 'margin:16px;font:600 15px sans-serif';
  box.append(p, b);
  const aria = probeAria(box);
  const sel = trySelect(box);
  return {
    library: 'DOM (baseline)',
    backingStoreRatio: null,
    hasAriaTree: aria.count > 0,
    roleButtonCount: aria.count,
    accessibleName: aria.name,
    selectableText: sel.ok,
    selectedSample: sel.text,
    notes: 'Native text + native <button>. The reference for crispness and selection.',
  };
}

// ── 2. VectoJS ───────────────────────────────────────────────────────────────
function vectojs(): Probe {
  const box = host('vecto', 'VectoJS');
  const canvas = document.createElement('canvas');
  box.appendChild(canvas);
  const scene = new Scene(canvas, { disableWindowResize: true });
  scene.resize(W, H);

  const label = new VText(LABEL, { font: '16px sans-serif', color: '#e6edf3' });
  label.setPosition(16, 24);
  scene.add(label);

  const btn = new Button(BTN, { onClick: () => {} });
  btn.setPosition(16, 90);
  scene.add(btn);

  scene.render((scene as unknown as { renderer: unknown }).renderer as never, 16, 16);
  (scene as unknown as { syncA11y: (r: Entity) => void }).syncA11y(
    (scene as unknown as { root: Entity }).root,
  );

  const aria = probeAria(box);
  const sel = trySelect(box);
  return {
    library: 'VectoJS',
    backingStoreRatio: backingRatio(box),
    hasAriaTree: aria.count > 0,
    roleButtonCount: aria.count,
    accessibleName: aria.name,
    selectableText: sel.ok,
    selectedSample: sel.text,
    notes: 'Canvas pixels + a transparent semantic DOM projection over them.',
  };
}

// ── 3. Konva ─────────────────────────────────────────────────────────────────
function konva(): Probe {
  const box = host('konva', 'Konva');
  const stage = new Konva.Stage({ container: box, width: W, height: H });
  const layer = new Konva.Layer();
  layer.add(
    new Konva.Text({
      x: 16,
      y: 16,
      text: LABEL,
      fontSize: 16,
      fill: '#e6edf3',
    }),
  );
  layer.add(
    new Konva.Rect({
      x: 16,
      y: 84,
      width: 130,
      height: 36,
      fill: '#2563eb',
      cornerRadius: 8,
    }),
  );
  layer.add(new Konva.Text({ x: 30, y: 95, text: BTN, fontSize: 15, fill: '#fff' }));
  stage.add(layer);
  layer.draw();

  const aria = probeAria(box);
  const sel = trySelect(box);
  return {
    library: 'Konva',
    backingStoreRatio: backingRatio(box),
    hasAriaTree: aria.count > 0,
    roleButtonCount: aria.count,
    accessibleName: aria.name,
    selectableText: sel.ok,
    selectedSample: sel.text,
    notes: 'Scene graph + hit-testing on canvas. No semantic projection in the library.',
  };
}

// ── 4. Fabric ────────────────────────────────────────────────────────────────
function fabricjs(): Probe {
  const box = host('fabric', 'Fabric.js');
  const el = document.createElement('canvas');
  el.width = W;
  el.height = H;
  box.appendChild(el);
  const c = new fabric.StaticCanvas(el, {
    width: W,
    height: H,
    backgroundColor: '#0d1117',
  });
  c.add(
    new fabric.FabricText(LABEL, {
      left: 16,
      top: 16,
      fontSize: 16,
      fill: '#e6edf3',
      fontFamily: 'sans-serif',
    }),
  );
  c.add(
    new fabric.Rect({
      left: 16,
      top: 84,
      width: 130,
      height: 36,
      fill: '#2563eb',
      rx: 8,
      ry: 8,
    }),
  );
  c.add(
    new fabric.FabricText(BTN, {
      left: 30,
      top: 95,
      fontSize: 15,
      fill: '#fff',
      fontFamily: 'sans-serif',
    }),
  );
  c.renderAll();

  const aria = probeAria(box);
  const sel = trySelect(box);
  return {
    library: 'Fabric.js',
    backingStoreRatio: backingRatio(box),
    hasAriaTree: aria.count > 0,
    roleButtonCount: aria.count,
    accessibleName: aria.name,
    selectableText: sel.ok,
    selectedSample: sel.text,
    notes: 'Object model + serialization on canvas. No semantic projection in the library.',
  };
}

function main() {
  const engine = /firefox/i.test(navigator.userAgent) ? 'firefox' : 'chrome';
  const probes: Probe[] = [];
  for (const fn of [domBaseline, vectojs, konva, fabricjs]) {
    try {
      probes.push(fn());
    } catch (e) {
      probes.push({
        library: fn.name,
        backingStoreRatio: null,
        hasAriaTree: false,
        roleButtonCount: 0,
        accessibleName: null,
        selectableText: false,
        selectedSample: null,
        notes: `THREW: ${String(e).slice(0, 160)}`,
      });
    }
  }

  const payload = {
    name: 'render-canvas-libs',
    engine,
    userAgent: navigator.userAgent,
    devicePixelRatio: window.devicePixelRatio,
    versions: { konva: '10.3.0', fabric: '7.4.0' },
    probes,
  };
  // Marker the screenshot driver waits on, so grim never captures mid-render.
  const done = document.createElement('div');
  done.id = 'probe-done';
  done.style.cssText = 'position:fixed;bottom:2px;right:4px;color:#3fb950;font:11px monospace';
  done.textContent = 'ready';
  document.body.appendChild(done);

  const pre = document.createElement('pre');
  pre.style.cssText = 'font:11px monospace;color:#8b949e;max-width:1200px;white-space:pre-wrap';
  pre.textContent = JSON.stringify(payload, null, 2);
  document.body.appendChild(pre);

  void fetch('/results', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  }).catch(() => {});
}

main();
