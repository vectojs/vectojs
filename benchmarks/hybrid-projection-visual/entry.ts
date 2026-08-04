// CTX-0198 / vectojs#343 — VISUAL verification of the hybrid projection split.
//
// The sibling `hybrid-projection` bench answers "what does it cost" in DOM nodes,
// heap and time. It cannot answer "is it correct", and a cost measurement against
// entities that draw nothing would not be worth much either. This page is the
// other half: real painted glyphs, a real browser selection, and a numeric
// alignment probe — and it is what the grim screenshots are taken of.
//
// Two scenes side by side, same document, same painted text:
//
//   LEFT   native  — every visible block carries per-run fine geometry (today)
//   RIGHT  hybrid  — only the band carries fine geometry; every other block is
//                    resident with text only (layer 2)
//
// Three things are checked, and all three are visible in a screenshot:
//
//   1. ALIGNMENT. A real Range is selected across several blocks in each scene.
//      Because the carriers are transparent and sit exactly over the canvas, the
//      browser paints its selection highlight on top of the drawn glyphs. If a
//      carrier is misplaced, the blue rectangle visibly slides off the text. The
//      HUD also reports max |Range rect - drawn glyph rect| in px, so the claim
//      does not rest on eyeballing a screenshot.
//   2. SELECTION CONTINUITY across block boundaries — the #345 contiguity
//      invariant that #343's selection lease has to generalize. Reported as the
//      number of blocks the selection actually spans.
//   3. FINDABILITY of OFF-SCREEN text, which is the capability hybrid buys and
//      native does not have. Probed by asking whether an off-band block's text
//      exists in the a11y DOM at all — native: no, hybrid: yes.
//
// Numbers here are for CORRECTNESS, not performance: two scenes share one page,
// so nothing about timing is quotable. Quote `hybrid-projection` for cost.
import { Entity, Scene } from '@vectojs/core';
import { reportFailure, reportResult } from '../_shared/client.ts';

const p = new URLSearchParams(location.search);
const BLOCKS = Number(p.get('blocks') ?? 60);
const LINES_PER_BLOCK = 3;
const RUNS_PER_LINE = 6;
const LINE_H = 22;
const FONT = '16px sans-serif';
const TEXT_LEFT = 6;
const BLOCK_GAP = 10;
const BLOCK_H = LINES_PER_BLOCK * LINE_H;
const BLOCK_PITCH = BLOCK_H + BLOCK_GAP;
const VIEW_W = 560;
const VIEW_H = 560;
/** How many blocks the selection spans, to exercise cross-block continuity. */
const SELECT_BLOCKS = Number(p.get('selectBlocks') ?? 4);

type Mode = 'native' | 'hybrid' | 'hybrid-windowed';

const measureCtx = document.createElement('canvas').getContext('2d')!;
measureCtx.font = FONT;
const advanceCache = new Map<string, number>();
function advance(text: string): number {
  let w = advanceCache.get(text);
  if (w === undefined) {
    w = measureCtx.measureText(text).width;
    advanceCache.set(text, w);
  }
  return w;
}

interface Run {
  text: string;
  x: number;
  width: number;
}

/**
 * The band that gets fine geometry in `hybrid`. In document coordinates, shared
 * by both scenes so the two differ only in mode.
 */
const band = { min: 0, max: 0 };

class Block extends Entity {
  private layoutCache: Run[][] | null = null;

  constructor(
    id: string,
    private readonly mode: Mode,
    private readonly docY: number,
    private readonly index: number,
  ) {
    super(id);
    this.width = VIEW_W - 24;
    this.height = BLOCK_H;
  }

  isPointInside(): boolean {
    return false;
  }

  /** Paint at exactly the coordinates the projection reports. */
  render(r: {
    fillText: (t: string, x: number, y: number, font: string, color: string) => void;
  }): void {
    const lines = this.layout();
    for (let i = 0; i < lines.length; i++) {
      // First line of each block is darker, so block boundaries are legible in a
      // screenshot and a selection crossing one is obvious.
      const color = i === 0 ? '#111' : '#444';
      for (const run of lines[i]!) r.fillText(run.text, run.x, i * LINE_H + 15, FONT, color);
    }
  }

  public inBand(): boolean {
    return this.docY + this.height >= band.min && this.docY <= band.max;
  }

  /**
   * Is this block actually inside the canvas viewport?
   *
   * Distinct from {@link inBand}: the band is deliberately taller than the
   * viewport (one screen of margin either side), so most band blocks are
   * off-screen and Scene sets `display: none` on their carriers. Selecting one of
   * those yields an empty Selection and a 0x0 rect — the highlight would be
   * invisible in a screenshot and the alignment probe would collect no samples.
   */
  public onScreen(): boolean {
    return this.y + this.height > 0 && this.y < VIEW_H;
  }

  public layout(): Run[][] {
    if (this.layoutCache) return this.layoutCache;
    const lines: Run[][] = [];
    for (let i = 0; i < LINES_PER_BLOCK; i++) {
      const runs: Run[] = [];
      let x = TEXT_LEFT;
      for (let r = 0; r < RUNS_PER_LINE; r++) {
        // Block index in the text, so a screenshot shows which block a selection
        // covers and the off-screen findability probe has a unique needle.
        const text = r === 0 ? `B${this.index}L${i} ` : `word${r} `;
        const width = advance(text);
        runs.push({ text, x, width });
        x += width;
      }
      lines.push(runs);
    }
    this.layoutCache = lines;
    return lines;
  }

  override getContentProjection(hint?: { minY?: number; maxY?: number }) {
    const layout = this.layout();
    if (this.mode !== 'native' && !this.inBand()) {
      return {
        text: layout.map((runs) => runs.map((r) => r.text).join('')).join('\n'),
        font: FONT,
        lineHeight: LINE_H,
        selectable: false,
      };
    }
    const lines = [];
    for (let i = 0; i < layout.length; i++) {
      const y = i * LINE_H;
      if (
        hint?.minY !== undefined &&
        hint.maxY !== undefined &&
        (y + LINE_H < hint.minY || y > hint.maxY)
      ) {
        continue;
      }
      const runs = layout[i]!;
      lines.push({
        text: runs.map((r) => r.text).join(''),
        x: TEXT_LEFT,
        y,
        baseline: 15,
        lineHeight: LINE_H,
        runs: runs.map((r) => ({ text: r.text, x: r.x, width: r.width })),
      });
    }
    return {
      text: lines.map((l) => l.text).join('\n'),
      font: FONT,
      lineHeight: LINE_H,
      selectable: true,
      lines,
    };
  }
}

interface SceneHandle {
  mode: Mode;
  scene: Scene;
  canvas: HTMLCanvasElement;
  blocks: Block[];
  host: HTMLElement;
}

function makeScene(mode: Mode, parent: HTMLElement): SceneHandle {
  const host = document.createElement('div');
  host.style.cssText = 'position:relative;flex:0 0 auto';
  const heading = document.createElement('div');
  heading.style.cssText =
    'font:600 13px system-ui;padding:6px 8px;background:#eef;border:1px solid #99a';
  heading.textContent =
    mode === 'native'
      ? 'native — fine geometry for every visible block (today)'
      : mode === 'hybrid-windowed'
        ? 'hybrid-windowed — band fine, rest text, margin FINITE (affordable)'
        : 'hybrid — fine geometry only in band; rest resident as text';
  host.appendChild(heading);

  const canvas = document.createElement('canvas');
  canvas.width = VIEW_W;
  canvas.height = VIEW_H;
  // Explicit CSS size, matching the backing store. `disableWindowResize` swaps
  // the window listener for a ResizeObserver on the element, so the element's own
  // laid-out size becomes authoritative — leaving it implicit would let flex
  // resize it and re-inflate the scene.
  canvas.style.cssText = `display:block;background:#fff;border:1px solid #99a;width:${VIEW_W}px;height:${VIEW_H}px;flex:0 0 auto`;
  host.appendChild(canvas);
  parent.appendChild(host);

  const scene = new Scene(canvas, {
    // Infinity for hybrid: the point is that off-band blocks stay resident, so
    // Scene's entity gate must not free them. native keeps a viewport margin,
    // which is exactly why its off-screen text has no DOM.
    // 'hybrid' uses an infinite margin so no block is ever freed — whole-document
    // reach, at the cost of disabling both engine gates (Scene.ts:4638), which the
    // cost bench measures at 41.8x native idle on Chrome at 10k blocks.
    // 'hybrid-windowed' uses a wide FINITE margin, which keeps both gates live and
    // measured 2.1x native. Findability then reaches the margin rather than the
    // whole document, and this page is where that distinction is checked against a
    // real DOM rather than asserted.
    contentProjectionMargin:
      mode === 'hybrid'
        ? Number.POSITIVE_INFINITY
        : mode === 'hybrid-windowed'
          ? VIEW_H * 12
          : VIEW_H,
    // Mandatory here: two scenes share this page, and Scene's default
    // window-resize handler resizes the canvas to the whole window. That made
    // both canvases 1300x1100 instead of 560x560, pushed every block outside the
    // exact-visibility test, and Scene correctly set `display: none` on all 90
    // carriers — so the selection was empty and every rect was 0x0 while the
    // HUD's DOM counts still looked plausible.
    disableWindowResize: true,
  });
  (scene as unknown as { isRunning: boolean }).isRunning = true;

  const docHeight = BLOCKS * BLOCK_PITCH;
  const scrollY = Math.max(0, docHeight / 2 - VIEW_H / 2);
  band.min = scrollY - VIEW_H;
  band.max = scrollY + VIEW_H * 2;

  const blocks: Block[] = [];
  for (let i = 0; i < BLOCKS; i++) {
    const docY = i * BLOCK_PITCH;
    const b = new Block(`${mode}-b${i}`, mode, docY, i);
    b.setPosition(12, docY - scrollY);
    scene.add(b);
    blocks.push(b);
  }
  // `step()`, not `render()`: Scene.render takes the renderer as an argument, so
  // a bare `render()` throws inside the engine on `renderer.isContextLost`.
  scene.step(16.67);
  const s = scene as unknown as {
    syncA11y: (r: unknown) => void;
    root: unknown;
  };
  s.syncA11y(s.root);
  return { mode, scene, canvas, blocks, host };
}

/**
 * Non-transparent pixels on a canvas.
 *
 * Reported per scene so "the projection DOM is correct" can never again be
 * mistaken for "the scene rendered". A blank canvas with a healthy carrier tree
 * is a real state this page reached, and only a screenshot caught it.
 */
function countInk(canvas: HTMLCanvasElement): number {
  const ctx = canvas.getContext('2d');
  if (!ctx || canvas.width === 0) return 0;
  const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  let ink = 0;
  for (let i = 3; i < data.length; i += 4) {
    if (data[i] !== 0) ink++;
  }
  return ink;
}

/**
 * The first or last descendant Text node of `node`.
 *
 * A Range endpoint has to be a Text node for a character offset to mean what the
 * probe intends. `native` carriers hold `<span>` children, while a `hybrid`
 * off-band carrier holds a bare text node, so the two paths reach different node
 * types and only this normalizes them.
 */
function deepestText(node: Node | null | undefined, end: 'first' | 'last'): Text | null {
  if (!node) return null;
  if (node.nodeType === Node.TEXT_NODE) return node as Text;
  const children = [...node.childNodes];
  if (end === 'last') children.reverse();
  for (const child of children) {
    const found = deepestText(child, end);
    if (found && found.data.length > 0) return found;
  }
  return null;
}

/** Rect of a drawn run in viewport coordinates, from the paint-side layout. */
function drawnRunRect(handle: SceneHandle, block: Block, line: number, run: number): DOMRect {
  const canvasRect = handle.canvas.getBoundingClientRect();
  const r = block.layout()[line]![run]!;
  return new DOMRect(
    canvasRect.left + block.x + r.x,
    canvasRect.top + block.y + line * LINE_H,
    r.width,
    LINE_H,
  );
}

interface Probe {
  mode: Mode;
  /** Blocks with any content-projection DOM. */
  projectedBlocks: number;
  /** Blocks carrying per-run fine geometry (a `<span>` inside the carrier). */
  fineGeometryBlocks: number;
  /** Total DOM nodes under this scene's a11y root. */
  domNodes: number;
  /** Is an off-band block's text present in the DOM (i.e. findable)? */
  offscreenTextInDom: boolean;
  /** Needle used for the findability probe. */
  offscreenNeedle: string;
  /** How many distinct blocks the applied selection covers. */
  selectionSpansBlocks: number;
  /** Characters the selection yielded. */
  selectionChars: number;
  /** max |Range rect - drawn glyph rect| over the probed runs, px. */
  maxAlignmentDriftPx: number | null;
  alignmentSamples: number;
  /** Non-transparent pixels on this scene's canvas. 0 means nothing was drawn. */
  paintedPixels: number;
  /** Canvas backing store, which is the CSS size times DPR. */
  backingStore: string;
}

/**
 * Select a real Range across several blocks, then compare where the browser puts
 * the selection to where the glyphs were drawn.
 */
function probe(handle: SceneHandle): Probe {
  const root = (handle.scene as unknown as { a11yRoot: HTMLElement | null }).a11yRoot!;
  const carriers = [...root.querySelectorAll('[data-vecto-content]')] as HTMLElement[];
  const fine = carriers.filter((el) => el.querySelector('span') !== null);
  // An off-band block that is far from the band, so `native` has certainly freed
  // it. Its text is unique per block, which makes the needle unambiguous.
  const offBand = handle.blocks.find((b) => !b.inBand());
  const needle = offBand ? `B${handle.blocks.indexOf(offBand)}L0` : '';
  const offscreenTextInDom = needle !== '' && (root.textContent ?? '').includes(needle);

  // Selection: from the first line of the first band block with fine geometry,
  // to a line SELECT_BLOCKS blocks later. Uses the real browser Selection, not a
  // simulated one, so continuity is genuinely exercised.
  let selectionSpansBlocks = 0;
  let selectionChars = 0;
  let maxDrift: number | null = null;
  let samples = 0;

  // On-screen, not merely in-band: an off-screen carrier is `display: none`, so a
  // selection over it is empty and invisible.
  const bandBlocks = handle.blocks.filter((b) => b.inBand() && b.onScreen());
  const startBlock = bandBlocks[1];
  const endBlock = bandBlocks[Math.min(1 + SELECT_BLOCKS, bandBlocks.length - 1)];
  if (startBlock && endBlock) {
    const startEl = root.querySelector(`[data-vecto-content="${startBlock.id}"] span`);
    const endCarrier = root.querySelector(`[data-vecto-content="${endBlock.id}"]`);
    const endEl = endCarrier?.querySelector('span') ?? endCarrier;
    // Resolve to real Text nodes. `setEnd` on an ELEMENT treats the offset as a
    // child index, not a character index, so passing a text length there throws
    // IndexSizeError — which is what happens whenever the `?? endCarrier`
    // fallback fires because a hybrid block has no `<span>`.
    const startText = deepestText(startEl, 'first');
    const endText = deepestText(endEl, 'last');
    if (startText && endText) {
      const range = document.createRange();
      range.setStart(startText, 0);
      range.setEnd(endText, endText.data.length);
      const selection = getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
      selectionChars = selection.toString().length;
      // How many block carriers the selection actually intersects.
      selectionSpansBlocks = carriers.filter((el) => range.intersectsNode(el)).length;

      // Alignment: for each of the first few band blocks, compare the Range rect
      // of run 0 against the rect the paint side used.
      for (const block of bandBlocks.slice(1, 1 + SELECT_BLOCKS)) {
        const carrier = root.querySelector(`[data-vecto-content="${block.id}"]`);
        const span = carrier?.querySelector('span');
        const textNode = deepestText(span, 'first');
        if (!textNode) continue;
        const runText = block.layout()[0]![0]!.text;
        const runRange = document.createRange();
        runRange.setStart(textNode, 0);
        runRange.setEnd(textNode, Math.min(runText.length, textNode.data.length));
        const domRect = runRange.getBoundingClientRect();
        const paintRect = drawnRunRect(handle, block, 0, 0);
        if (domRect.width === 0) continue;
        const drift = Math.max(
          Math.abs(domRect.left - paintRect.left),
          Math.abs(domRect.top - paintRect.top),
        );
        maxDrift = maxDrift === null ? drift : Math.max(maxDrift, drift);
        samples++;
      }
    }
  }

  return {
    mode: handle.mode,
    projectedBlocks: carriers.length,
    fineGeometryBlocks: fine.length,
    domNodes: root.querySelectorAll('*').length,
    offscreenTextInDom,
    offscreenNeedle: needle,
    selectionSpansBlocks,
    selectionChars,
    maxAlignmentDriftPx: maxDrift === null ? null : +maxDrift.toFixed(2),
    alignmentSamples: samples,
    paintedPixels: countInk(handle.canvas),
    backingStore: `${handle.canvas.width}x${handle.canvas.height}`,
  };
}

async function main(): Promise<void> {
  document.body.style.cssText = 'margin:0;font:13px system-ui;background:#f6f6f8';
  const strip = document.createElement('div');
  strip.style.cssText = 'display:flex;gap:12px;padding:12px;align-items:flex-start';
  document.body.appendChild(strip);

  // Both scenes live at once, side by side, so one screenshot shows the
  // difference. That makes the page unusable for timing, which is deliberate —
  // cost belongs to the sibling bench.
  const native = makeScene('native', strip);
  const hybrid = makeScene('hybrid', strip);
  // The third scene is the one the decision rests on. `hybrid` (infinite margin)
  // proves the capability but costs 41.8x native idle; `hybrid-windowed` costs
  // 2.1x. Both must be shown, because the interesting question is not whether
  // resident text is findable — it is whether the AFFORDABLE variant still is,
  // out to its margin.
  const windowed = makeScene('hybrid-windowed', strip);
  // Exposed for interactive inspection (MCP `evaluate_script`). A visual page's
  // whole purpose is to be looked at and poked, and without a handle every
  // question about it has to be answered by rebuilding the page.
  (window as unknown as { __vecto: unknown }).__vecto = {
    native,
    hybrid,
    windowed,
    band,
    VIEW_W,
    VIEW_H,
  };

  // Repaint AFTER both scenes exist and the DPR-driven backing-store resize has
  // settled. `makeScene` already stepped once, but on a fractional-DPR display
  // (measured: scale 1.6 → 896x896 backing for a 560x560 canvas) that first paint
  // is discarded by the resize, and with `renderMode: 'always'` the scene's own
  // rAF loop only restores it a frame or two later. A screenshot taken in that
  // window shows a blank canvas while every DOM count still looks correct — which
  // is exactly how this page reported healthy numbers over an empty canvas.
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  for (const handle of [native, hybrid, windowed]) {
    handle.scene.markDirty();
    handle.scene.step(16.67);
  }

  // Hybrid first, then native. `getSelection()` is per-DOCUMENT and each probe
  // does removeAllRanges() + addRange(), so only the LAST arm's selection
  // survives to be photographed. Probing native last leaves the highlight on the
  // arm a reader is most likely to check against today's behaviour — and, more
  // importantly, makes the ordering explicit instead of accidental. It also
  // removes a real trap: with hybrid last, the earlier captures showed a
  // highlight only on the right panel, which reads as "only the right canvas
  // painted" and is how this page was misdiagnosed for several iterations.
  const windowedProbe = probe(windowed);
  const hybridProbe = probe(hybrid);
  const nativeProbe = probe(native);
  const probes = [nativeProbe, hybridProbe, windowedProbe];

  const hud = document.createElement('pre');
  hud.style.cssText =
    'margin:0 12px 12px;padding:10px;background:#111;color:#dfe;font:12px monospace;white-space:pre;border-radius:4px';
  const line = (label: string, a: unknown, b: unknown, c: unknown): string =>
    `${label.padEnd(30)} ${String(a).padStart(12)} ${String(b).padStart(12)} ${String(c).padStart(16)}`;
  const [n, h, w] = probes as [Probe, Probe, Probe];
  hud.textContent = [
    `vectojs#343 hybrid content projection — visual + numeric verification`,
    `${BLOCKS} blocks, selection spans ${SELECT_BLOCKS} blocks, dpr ${devicePixelRatio}`,
    '',
    line('', 'native', 'hybrid', 'hybrid-windowed'),
    line('blocks with any DOM', n.projectedBlocks, h.projectedBlocks, w.projectedBlocks),
    line(
      'blocks with fine geometry',
      n.fineGeometryBlocks,
      h.fineGeometryBlocks,
      w.fineGeometryBlocks,
    ),
    line('DOM nodes under a11yRoot', n.domNodes, h.domNodes, w.domNodes),
    line(
      'off-screen text findable',
      n.offscreenTextInDom,
      h.offscreenTextInDom,
      w.offscreenTextInDom,
    ),
    line(
      'selection spans blocks',
      n.selectionSpansBlocks,
      h.selectionSpansBlocks,
      w.selectionSpansBlocks,
    ),
    line('selection chars', n.selectionChars, h.selectionChars, w.selectionChars),
    line(
      'max alignment drift px',
      n.maxAlignmentDriftPx,
      h.maxAlignmentDriftPx,
      w.maxAlignmentDriftPx,
    ),
    line('alignment samples', n.alignmentSamples, h.alignmentSamples, w.alignmentSamples),
    line('canvas painted pixels', n.paintedPixels, h.paintedPixels, w.paintedPixels),
    line('canvas backing store', n.backingStore, h.backingStore, w.backingStore),
    '',
    'The blue highlight is the REAL browser selection painted over canvas glyphs.',
    'If a transparent carrier were misplaced, it would visibly slide off the text.',
    '',
    'Only ONE highlight is visible by design: getSelection() is per-document, so the',
    'arm probed last (native) owns it. Selected text draws WHITE on blue, so do not',
    'read "highlighted" as "painted" — check that every on-screen block shows dark',
    'glyphs, not just the selected range.',
  ].join('\n');
  document.body.appendChild(hud);

  // Mark ready for the screenshot driver. Set after layout and selection are
  // applied, so a capture triggered by this flag cannot catch a half-built page.
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      document.title = 'hybrid-projection-visual READY';
      (window as unknown as { __visualReady: boolean }).__visualReady = true;
    });
  });

  await reportResult({
    name: 'hybrid-projection-visual',
    params: {
      BLOCKS,
      SELECT_BLOCKS,
      LINES_PER_BLOCK,
      RUNS_PER_LINE,
      VIEW_W,
      VIEW_H,
      note: 'correctness/capability verification with real painted glyphs and a real browser Selection; two scenes share one page so NO timing here is quotable',
    },
    rows: probes,
    syntheticFrames: true,
  });
}

main().catch((error) => reportFailure('hybrid-projection-visual', error));
