// Projection-policy dogfood (RFC4 §6, CTX-0601): one Markdown document with a
// live canvas / dom / hybrid switcher over the real Markdown renderer.
//
// - canvas  forces `domPolicy: 'canvas'` on the whole subtree. The regression
//           gate: identical to today; content projection still provides
//           findability. Any pixel delta vs main is a plumbing bug, not policy.
// - dom     forces `domPolicy: 'dom'` on supported blocks (prose + code).
//           Browser-native selection, Ctrl+F, translation over the article.
// - hybrid  sets `domPolicy: 'auto'` everywhere: prose/code negotiate to `dom`,
//           tables/figures/backgrounds stay `canvas`. The readout shows the
//           per-block resolution + fallback reason (§3 rule 2).
//
// Explicitly out (RFC4 §6): editing/IME, RTL-heavy documents, export-from-
// hybrid, images (a decoded bitmap would add raster nondeterminism to the
// checksum gate, so the corpus carries none — images map to `canvas` by the
// matrix row, exercised in unit tests instead). Math is excluded for the same
// reason (MathJax is an async engine download).
//
// URL parameters (namespaced to avoid the harness's own `mode`/`runId`/…:
// `mode=hybrid` would read as harness `measure` and arm the cadence gate):
//   `policy`  `canvas` | `dom` | `hybrid` | `all` (default `all`: sweep every
//             mode, measure, report; the page ends on the last mode).
//
// Ship criterion (RFC4 §6): hybrid reaches selection parity with dom on prose
// while frame cost stays within noise of canvas on figure-heavy scrolls —
// measured with benchmarks/run-browsers.sh on both engines, never headless:
//   bun benchmarks/runner/cli.ts benchmarks/projection-policy --browser chrome
//   bun benchmarks/runner/cli.ts benchmarks/projection-policy --browser firefox
import { Entity, Scene } from '@vectojs/core';
import { DOMProjection, type DOMKindSpec } from '@vectojs/dom';
import {
  applyProjectionMode,
  classifyProjectionBlocks,
  Markdown,
  type ClassifiedProjectionBlock,
  type MarkdownProjectionMode,
} from '@vectojs/markdown';
import { Stack } from '@vectojs/ui';
import {
  awaitStart,
  calibrateRefreshRate,
  reportFailure,
  reportResult,
} from '../_shared/client.ts';

const p = new URLSearchParams(location.search);
const POLICY = p.get('policy') ?? 'all';
const MODES = (
  POLICY === 'all' ? ['canvas', 'dom', 'hybrid'] : [POLICY]
) as MarkdownProjectionMode[];

const CORPUS = [
  '# Projection policy dogfood',
  '',
  'Every block below negotiates its own backend in hybrid mode. Prose blocks',
  'resolve to live DOM so selection, find-in-page, and translation work',
  'natively; figures and chrome stay canvas pixels.',
  '',
  '```js',
  'function negotiate(node) {',
  "  if (node.policy === 'canvas') return 'canvas';",
  '  return weighInteraction(node) ?? node.fallback;',
  '}',
  '```',
  '',
  '> A blockquote exercises the container arm: the wrapper negotiates as a',
  '> group while its text child negotiates alone.',
  '',
  '- first list item',
  '- second list item',
  '- third list item',
  '',
  '| kind | auto resolves to |',
  '| ---- | ---------------- |',
  '| prose | dom |',
  '| code | canvas |',
  '| table | canvas |',
  '',
  '---',
  '',
  'A closing paragraph pins the table above in the viewport while scrolling,',
  'so the hybrid census covers more than one block class at once.',
  '',
].join('\n');

const VIEW_W = 900;
const VIEW_H = 700;
const DOC_WIDTH = 860;

/** `prose` kind: selectable div fed by ui `Text.text` or RichText projection. */
const proseSpec: DOMKindSpec = {
  tag: 'div',
  create(): HTMLElement {
    const el = document.createElement('div');
    el.style.userSelect = 'text';
    return el;
  },
  sync(node, el, fields): void {
    // ui Text carries `.text`; RichText carries spans, so fall back to its
    // content projection (rebuilt per frame here — dogfood scale only; the
    // write itself is dirty-checked, so steady-state frames touch no DOM).
    const props = node as unknown as { text?: unknown };
    const projected = (node as Entity).getContentProjection?.()?.text;
    const text = typeof props.text === 'string' ? props.text : projected;
    fields.write('text', typeof text === 'string' ? text : '', (v) => {
      el.textContent = v ?? '';
    });
  },
};

/** `code` kind: `pre` fed by the block's content projection (source text). */
const codeSpec: DOMKindSpec = {
  tag: 'pre',
  create(): HTMLElement {
    return document.createElement('pre');
  },
  sync(node, el, fields): void {
    const text = (node as Entity).getContentProjection?.()?.text;
    fields.write('code', typeof text === 'string' ? text : '', (v) => {
      el.textContent = v ?? '';
    });
  },
};

function checksum(canvas: HTMLCanvasElement): string {
  const ctx = canvas.getContext('2d')!;
  const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  let hash = 0x811c9dc5;
  for (let i = 0; i < data.length; i += 64) {
    hash ^= data[i]!;
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

const yieldFrame = (): Promise<void> => new Promise((r) => requestAnimationFrame(() => r()));

async function main(): Promise<void> {
  await awaitStart();
  await calibrateRefreshRate();
  const startedAt = performance.now();

  document.body.style.margin = '0';
  document.body.style.font = '12px monospace';

  const canvas = document.createElement('canvas');
  canvas.width = VIEW_W;
  canvas.height = VIEW_H;
  canvas.style.cssText = `display:block;width:${VIEW_W}px;height:${VIEW_H}px`;
  document.body.appendChild(canvas);

  const scene = new Scene(canvas, { disableWindowResize: true });
  scene.renderMode = 'always';
  const projection = new DOMProjection(canvas);
  projection.registerKind('prose', proseSpec);
  projection.registerKind('code', codeSpec);
  scene.addProjectionBackend(projection);

  const root = new Stack({ direction: 'vertical', gap: 8 });
  const markdown = new Markdown(CORPUS, {
    maxWidth: DOC_WIDTH,
    blockAffordances: false,
  });
  root.add(markdown);
  scene.add(root);
  root.layout();
  scene.resize(VIEW_W, VIEW_H);
  scene.start();

  const blocks: ClassifiedProjectionBlock[] = classifyProjectionBlocks(markdown.content);

  const chrome = document.createElement('div');
  chrome.style.cssText = 'padding:8px;display:flex;gap:8px;align-items:center';
  const readout = document.createElement('div');
  readout.style.cssText = 'padding:0 8px 8px';
  document.body.appendChild(chrome);
  document.body.appendChild(readout);

  const renderReadout = (mode: string): void => {
    const rows = blocks
      .map(({ node, label }) => {
        const r = scene.getProjectionResolution(node.id);
        return `<tr><td>${label}</td><td>${r?.want ?? '—'}</td><td>${r?.resolved ?? '—'}</td><td>${r?.reason ?? '—'}</td></tr>`;
      })
      .join('');
    readout.innerHTML =
      `<div>mode: <b>${mode}</b> — per-block resolution + fallback reason (§3 rule 2).</div>` +
      `<table border="1" cellpadding="4"><tr><th>block</th><th>want</th><th>resolved</th><th>reason</th></tr>${rows}</table>`;
  };

  for (const mode of ['canvas', 'dom', 'hybrid'] as const satisfies MarkdownProjectionMode[]) {
    const button = document.createElement('button');
    button.textContent = mode;
    button.onclick = () => {
      applyProjectionMode(markdown, mode);
      scene.markDirty();
      void yieldFrame().then(() => renderReadout(mode));
    };
    chrome.appendChild(button);
  }

  const rows: Record<string, unknown>[] = [];
  const issues: string[] = [];
  let canvasChecksum = '';
  for (const mode of MODES) {
    applyProjectionMode(markdown, mode);
    scene.markDirty();
    // Settle: one frame to negotiate + mount, one for dirty-checked steady
    // state, one for the a11y/content sync the loop owns (step() never runs
    // it, so only the live loop counts here).
    await yieldFrame();
    await yieldFrame();
    await yieldFrame();
    renderReadout(mode);
    // Render-walk cost only: step() runs the walk + backend sync but not the
    // a11y/content sync, so this is the negotiation floor, not the ceiling.
    const times: number[] = [];
    for (let i = 0; i < 20; i++) {
      const t0 = performance.now();
      scene.step(16.67);
      times.push(performance.now() - t0);
    }
    times.sort((a, b) => a - b);
    const domNodes = projection.getRoot()?.childElementCount ?? 0;
    const sum = checksum(canvas);
    if (mode === 'canvas') {
      if (!canvasChecksum) canvasChecksum = sum;
      else if (canvasChecksum !== sum) {
        issues.push(`canvas checksum drifted within one load: ${canvasChecksum} vs ${sum}`);
      }
    }
    const resolutions = blocks.map(({ node, label }) => {
      const r = scene.getProjectionResolution(node.id);
      return {
        block: label,
        want: r?.want ?? null,
        resolved: r?.resolved ?? null,
        reason: r?.reason ?? null,
      };
    });
    const domResolved = resolutions.filter((r) => r.resolved === 'dom').length;
    if (mode === 'dom' && domResolved === 0) issues.push('dom mode resolved zero blocks to dom');
    if (mode === 'hybrid' && !resolutions.some((r) => r.resolved === 'dom')) {
      issues.push('hybrid mode resolved zero blocks to dom (prose should negotiate dom)');
    }
    if (mode === 'hybrid' && !resolutions.some((r) => r.resolved === 'canvas')) {
      issues.push('hybrid mode resolved zero blocks to canvas (figures should stay canvas)');
    }
    rows.push({
      mode,
      stepMsMedian: +times[10]!.toFixed(4),
      domNodes,
      canvasChecksum: sum,
      resolutions,
    });
    await yieldFrame();
  }

  const result = await reportResult({
    name: 'projection-policy',
    params: {
      modes: MODES,
      corpusBlocks: blocks.length,
      view: [VIEW_W, VIEW_H],
      docWidth: DOC_WIDTH,
    },
    rows,
    summary: {
      canvasChecksum,
      note: 'canvasChecksum is the regression gate: canvas mode must be byte-identical to today. stepMsMedian is the render-walk floor (excludes a11y/content sync); quotable frame figures need run-browsers.sh on both engines.',
    },
    issues,
    durationMs: +(performance.now() - startedAt).toFixed(1),
  });
  const pre = document.createElement('pre');
  pre.textContent = JSON.stringify(result, null, 2);
  document.body.appendChild(pre);
  document.title = `projection-policy ${MODES.join(',')} READY`;
}

main().catch((error) => reportFailure('projection-policy', error));
