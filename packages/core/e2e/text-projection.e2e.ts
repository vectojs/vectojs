/**
 * Real-browser regression coverage for canvas text content projection.
 *
 * The suite deliberately exercises browser Range geometry, source-order copy,
 * font substitution, forced colors, ligatures, RTL text, DPR, and CSS zoom.
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import puppeteer, { type Browser, type Page } from 'puppeteer-core';

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const pageMarkup = `<!doctype html><html><body style="margin:0"><canvas id="canvas" width="1200" height="1400" style="display:block"></canvas><script type="module" src="/fixture.mjs"></script></body></html>`;

interface BrowserCase {
  name: string;
  browser: 'chrome' | 'firefox';
  executablePath: string;
  dpr: number;
  zoom?: number;
  extraPrefsFirefox?: Record<string, boolean | number | string>;
  forcedColors?: boolean;
}

function executable(candidates: string[], label: string): string {
  const path = candidates.find(existsSync);
  if (!path) throw new Error(`No ${label} executable found (${candidates.join(', ')})`);
  return path;
}

async function instrumentCanvas(page: Page): Promise<void> {
  await page.evaluateOnNewDocument(() => {
    const trace: Array<Record<string, unknown>> = [];
    Object.defineProperty(window, '__vectoFillTrace', { value: trace });
    const original = CanvasRenderingContext2D.prototype.fillText;
    CanvasRenderingContext2D.prototype.fillText = function (
      text: string,
      x: number,
      y: number,
      maxWidth?: number,
    ) {
      const metrics = this.measureText(String(text));
      const transform = this.getTransform();
      trace.push({
        text: String(text),
        x,
        y,
        font: this.font,
        width: metrics.width,
        left: metrics.actualBoundingBoxLeft,
        right: metrics.actualBoundingBoxRight,
        a: transform.a,
        b: transform.b,
        c: transform.c,
        d: transform.d,
        // Translation, so a draw can be attributed to the entity that made it.
        // Trace x/y are entity-LOCAL (the draw walk translates by node.x/node.y
        // before calling render()), so local coordinates alone cannot tell two
        // blocks apart when their local boxes overlap — which they usually do.
        e: transform.e,
        f: transform.f,
      });
      return maxWidth === undefined
        ? original.call(this, text, x, y)
        : original.call(this, text, x, y, maxWidth);
    };
    // Trace atlas blits into the SAME buffer as fillText.
    //
    // `CodeBlock` draws its grid with the 9-argument `drawImage` from a
    // `GlyphRasterAtlas` where the renderer supports it, so a fillText-only hook
    // sees an empty trace for code and every grid assertion below silently stops
    // testing anything — which is how it was first noticed: the check did not
    // fail, it crashed on an empty array.
    //
    // A blit exposes only a destination rect, so the glyph and its ink metrics
    // come from the atlas via `slotAt(sx, sy)`. The recorded shape is identical to
    // the fillText entries, letting the existing overlap and cell-width
    // assertions work on either draw path unchanged.
    const originalDrawImage = CanvasRenderingContext2D.prototype.drawImage;
    CanvasRenderingContext2D.prototype.drawImage = function (
      this: CanvasRenderingContext2D,
      ...args: unknown[]
    ) {
      if (args.length === 9) {
        const [source, sx, sy, , , dx, dy] = args as [
          CanvasImageSource,
          number,
          number,
          number,
          number,
          number,
          number,
          number,
          number,
        ];
        const lookup = (
          window as unknown as {
            __vectoAtlasSlotAt?: (
              s: CanvasImageSource,
              x: number,
              y: number,
            ) => {
              glyph: string;
              advance: number;
              left: number;
              right: number;
              offsetX: number;
              offsetY: number;
              font?: string;
            } | null;
          }
        ).__vectoAtlasSlotAt;
        const slot = lookup ? lookup(source, sx, sy) : null;
        if (slot) {
          const transform = this.getTransform();
          trace.push({
            text: slot.glyph,
            // Undo the blit offsets to recover the glyph origin and baseline that
            // an equivalent fillText would have been given.
            x: dx + slot.offsetX,
            y: dy + slot.offsetY,
            font: slot.font ?? this.font,
            width: slot.advance,
            left: slot.left,
            right: slot.right,
            a: transform.a,
            b: transform.b,
            c: transform.c,
            d: transform.d,
            e: transform.e,
            f: transform.f,
          });
        }
      }
      return (originalDrawImage as (...a: unknown[]) => void).apply(this, args);
    } as typeof CanvasRenderingContext2D.prototype.drawImage;
    const rangeGeometryReads = { bounding: 0, clientRects: 0 };
    Object.defineProperty(window, '__vectoRangeGeometryReads', {
      value: rangeGeometryReads,
    });
    Object.defineProperty(window, '__vectoResetRangeGeometryReads', {
      value: () => {
        rangeGeometryReads.bounding = 0;
        rangeGeometryReads.clientRects = 0;
      },
    });
    const originalRangeRect = Range.prototype.getBoundingClientRect;
    Range.prototype.getBoundingClientRect = function () {
      rangeGeometryReads.bounding++;
      return originalRangeRect.call(this);
    };
    const originalRangeRects = Range.prototype.getClientRects;
    Range.prototype.getClientRects = function () {
      rangeGeometryReads.clientRects++;
      return originalRangeRects.call(this);
    };
  });
}

async function screenshotDiff(
  page: Page,
  targetId: string,
): Promise<{
  unselectedRatio: number;
  maxChannelDelta: number;
  selectedPixels: number;
}> {
  const clip = await page.evaluate((id) => {
    const app = (window as any).__vecto;
    const element = app.scene.getContentElement(id) as HTMLElement;
    const bounds = element.getBoundingClientRect();
    (document.getElementById('canvas') as HTMLElement).style.visibility = 'hidden';
    getSelection()?.removeAllRanges();
    return {
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: bounds.height,
    };
  }, targetId);

  const safeClip = {
    x: Math.max(0, clip.x),
    y: Math.max(0, clip.y),
    width: Math.max(1, clip.width),
    height: Math.max(1, clip.height),
  };
  const unselected = await page.screenshot({ clip: safeClip });
  await page.evaluate((id) => {
    const app = (window as any).__vecto;
    (app.scene.getContentElement(id) as HTMLElement).style.visibility = 'hidden';
  }, targetId);
  const control = await page.screenshot({ clip: safeClip });
  await page.evaluate((id) => {
    const app = (window as any).__vecto;
    const element = app.scene.getContentElement(id) as HTMLElement;
    element.style.visibility = '';
    const range = document.createRange();
    range.selectNodeContents(element);
    const selection = getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
  }, targetId);
  const selected = await page.screenshot({ clip: safeClip });

  const result = await page.evaluate(
    async (images) => {
      const pixels = async (base64: string) => {
        const image = new Image();
        image.src = `data:image/png;base64,${base64}`;
        await image.decode();
        const canvas = document.createElement('canvas');
        canvas.width = image.naturalWidth;
        canvas.height = image.naturalHeight;
        const context = canvas.getContext('2d')!;
        context.drawImage(image, 0, 0);
        return context.getImageData(0, 0, canvas.width, canvas.height).data;
      };
      const [plain, hidden, active] = await Promise.all([
        pixels(images.unselected),
        pixels(images.control),
        pixels(images.selected),
      ]);
      let unselectedPixels = 0;
      let selectedPixels = 0;
      let maxChannelDelta = 0;
      for (let offset = 0; offset < hidden.length; offset += 4) {
        let plainChanged = false;
        let selectedChanged = false;
        for (let channel = 0; channel < 3; channel++) {
          const plainDelta = Math.abs(plain[offset + channel] - hidden[offset + channel]);
          const selectedDelta = Math.abs(active[offset + channel] - hidden[offset + channel]);
          maxChannelDelta = Math.max(maxChannelDelta, plainDelta);
          plainChanged ||= plainDelta > 2;
          selectedChanged ||= selectedDelta > 2;
        }
        if (plainChanged) unselectedPixels++;
        if (selectedChanged) selectedPixels++;
      }
      return {
        unselectedRatio: unselectedPixels / (hidden.length / 4),
        maxChannelDelta,
        selectedPixels,
      };
    },
    {
      unselected: Buffer.from(unselected).toString('base64'),
      control: Buffer.from(control).toString('base64'),
      selected: Buffer.from(selected).toString('base64'),
    },
  );

  await page.evaluate(() => {
    (document.getElementById('canvas') as HTMLElement).style.visibility = '';
    getSelection()?.removeAllRanges();
  });
  return result;
}

async function dragAcrossCodeBlankRegions(
  page: Page,
  reverse: boolean,
): Promise<{
  text: string;
  rootPointerEvents: string;
  rangeGeometryReads: { bounding: number; clientRects: number };
  anchor: string | null;
  anchorOffset: number | null;
  focus: string | null;
  focusOffset: number | null;
}> {
  const points = await page.evaluate(() => {
    const app = (window as any).__vecto;
    const root = app.scene.getContentElement(app.code.id) as HTMLElement;
    const rootRect = root.getBoundingClientRect();
    const first = root.children[0].getBoundingClientRect();
    const second = root.children[1].getBoundingClientRect();
    return {
      start: { x: rootRect.left + 4, y: first.top + first.height / 2 },
      end: {
        x: Math.min(rootRect.right - 4, second.right + 20),
        y: second.top + second.height / 2,
      },
    };
  });
  const start = reverse ? points.end : points.start;
  const end = reverse ? points.start : points.end;
  await page.evaluate(() => (window as any).__vectoResetRangeGeometryReads());
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(end.x, end.y, { steps: 32 });
  await page.mouse.up();
  return page.evaluate(() => {
    const app = (window as any).__vecto;
    const root = app.scene.getContentElement(app.code.id) as HTMLElement;
    return {
      text: getSelection()?.toString() ?? '',
      rootPointerEvents: root.parentElement?.style.pointerEvents ?? '',
      anchor: getSelection()?.anchorNode?.textContent ?? null,
      anchorOffset: getSelection()?.anchorOffset ?? null,
      focus: getSelection()?.focusNode?.textContent ?? null,
      focusOffset: getSelection()?.focusOffset ?? null,
      rangeGeometryReads: { ...(window as any).__vectoRangeGeometryReads },
    };
  });
}

async function clickGridSource(
  page: Page,
  entityKey: 'code' | 'transformedCode',
  sourceText: string,
  visualFraction: number,
  clickCount = 1,
  shiftKey = false,
): Promise<{
  text: string;
  anchorOffset: number;
  sourceLength: number;
  sourceStart: number;
  sourceEnd: number;
}> {
  const target = await page.evaluate(
    ({ entityKey, sourceText, visualFraction }) => {
      const app = (window as any).__vecto;
      const entity = app[entityKey];
      const root = app.scene.getContentElement(entity.id) as HTMLElement;
      const cell = [...root.querySelectorAll<HTMLElement>('[data-vecto-grid-cell]')].find(
        (candidate) => {
          const length = Number(candidate.dataset.vectoGridSourceLength);
          return candidate.textContent?.slice(0, length) === sourceText;
        },
      );
      if (!cell) throw new Error(`Missing grid source ${sourceText}`);
      const matrix = entity.getWorldTransform();
      if (
        matrix.a > 0 &&
        matrix.d > 0 &&
        Math.abs(matrix.b) <= 0.001 &&
        Math.abs(matrix.c) <= 0.001
      ) {
        const rect = cell.getBoundingClientRect();
        return {
          x: rect.left + rect.width * visualFraction,
          y: rect.top + rect.height / 2,
        };
      }
      const line = cell.parentElement!;
      const localX =
        (Number.parseFloat(line.style.left) || 0) +
        Number(cell.dataset.vectoGridX) +
        Number(cell.dataset.vectoGridAdvance) * visualFraction;
      const localY =
        (Number.parseFloat(line.style.top) || 0) + (Number.parseFloat(line.style.height) || 0) / 2;
      const basisLine = root.querySelector<HTMLElement>('[data-vecto-grid-line]')!;
      const origin = basisLine
        .querySelector<HTMLElement>('[data-vecto-grid-basis="origin"]')!
        .getBoundingClientRect();
      const xPoint = basisLine
        .querySelector<HTMLElement>('[data-vecto-grid-basis="x"]')!
        .getBoundingClientRect();
      const yPoint = basisLine
        .querySelector<HTMLElement>('[data-vecto-grid-basis="y"]')!
        .getBoundingClientRect();
      const basisLeft = Number.parseFloat(basisLine.style.left) || 0;
      const basisTop = Number.parseFloat(basisLine.style.top) || 0;
      const dx = localX - basisLeft;
      const dy = localY - basisTop;
      return {
        x: origin.left + (xPoint.left - origin.left) * dx + (yPoint.left - origin.left) * dy,
        y: origin.top + (xPoint.top - origin.top) * dx + (yPoint.top - origin.top) * dy,
      };
    },
    { entityKey, sourceText, visualFraction },
  );
  if (clickCount > 1) {
    await page.evaluate(
      ({ x, y, clickCount }) => {
        const target = document.elementFromPoint(x, y);
        if (!target) throw new Error('Missing click target');
        for (let detail = 1; detail <= clickCount; detail++) {
          for (const type of ['mousedown', 'mouseup', 'click']) {
            target.dispatchEvent(
              new MouseEvent(type, {
                bubbles: true,
                cancelable: true,
                button: 0,
                clientX: x,
                clientY: y,
                detail,
              }),
            );
          }
          if (detail === 2) {
            target.dispatchEvent(
              new MouseEvent('dblclick', {
                bubbles: true,
                cancelable: true,
                button: 0,
                clientX: x,
                clientY: y,
                detail,
              }),
            );
          }
        }
      },
      { ...target, clickCount },
    );
  } else {
    if (shiftKey) await page.keyboard.down('Shift');
    await page.mouse.click(target.x, target.y);
    if (shiftKey) await page.keyboard.up('Shift');
  }
  return page.evaluate(() => {
    const selection = getSelection()!;
    const cell = selection.anchorNode?.parentElement as HTMLElement;
    return {
      text: selection.toString(),
      anchorOffset: selection.anchorOffset,
      sourceLength: Number(cell?.dataset.vectoGridSourceLength ?? 0),
      sourceStart: Number(cell?.dataset.vectoGridSourceStart ?? -1),
      sourceEnd: Number(cell?.dataset.vectoGridSourceEnd ?? -1),
    };
  });
}

async function clickProjectionEdge(
  page: Page,
  entityKey: 'rtl',
  edge: 'left' | 'right',
): Promise<{ anchorOffset: number; sourceLength: number }> {
  const target = await page.evaluate(
    ({ entityKey, edge }) => {
      const app = (window as any).__vecto;
      const entity = app[entityKey];
      const root = app.scene.getContentElement(entity.id) as HTMLElement;
      const line = root.children[0] as HTMLElement;
      const rect = line.getBoundingClientRect();
      return {
        x: edge === 'left' ? rect.left + 1 : rect.right - 1,
        y: rect.top + rect.height / 2,
      };
    },
    { entityKey, edge },
  );
  await page.mouse.click(target.x, target.y);
  return page.evaluate(() => {
    const selection = getSelection()!;
    return {
      anchorOffset: selection.anchorOffset,
      sourceLength: selection.anchorNode?.textContent?.length ?? 0,
    };
  });
}

async function clickOrdinarySource(
  page: Page,
  entityKey: 'rotatedText' | 'mirroredRich' | 'flowProjection',
  sourceText: string,
): Promise<{
  absoluteOffset: number;
  expectedStart: number;
  expectedEnd: number;
  hitContentId: string | null;
  expectedContentId: string;
}> {
  const target = await page.evaluate(
    ({ entityKey, sourceText }) => {
      const app = (window as any).__vecto;
      const root = app.scene.getContentElement(app[entityKey].id) as HTMLElement;
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      const nodes: Text[] = [];
      let node: Text | null;
      while ((node = walker.nextNode() as Text | null)) nodes.push(node);
      const textNode = nodes.find((candidate) => candidate.data.includes(sourceText));
      if (!textNode) throw new Error(`Missing ordinary projection source ${sourceText}`);
      const localStart = textNode.data.indexOf(sourceText);
      const localEnd = localStart + sourceText.length;
      const range = document.createRange();
      range.setStart(textNode, localStart);
      range.setEnd(textNode, localEnd);
      const rect = range.getBoundingClientRect();
      const priorLength = nodes
        .slice(0, nodes.indexOf(textNode))
        .reduce((total, candidate) => total + candidate.data.length, 0);
      return {
        entityKey,
        expectedContentId: root.dataset.vectoContent!,
        x: rect.left + rect.width / 2,
        y: rect.top + rect.height / 2,
        expectedStart: priorLength + localStart,
        expectedEnd: priorLength + localEnd,
      };
    },
    { entityKey, sourceText },
  );
  await page.mouse.click(target.x, target.y);
  return page.evaluate(({ entityKey, expectedContentId, expectedStart, expectedEnd, x, y }) => {
    const app = (window as any).__vecto;
    const root = app.scene.getContentElement(app[entityKey].id) as HTMLElement;
    const selection = getSelection()!;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let absoluteOffset = 0;
    let node: Text | null;
    while ((node = walker.nextNode() as Text | null)) {
      if (node === selection.anchorNode) {
        absoluteOffset += selection.anchorOffset;
        break;
      }
      absoluteOffset += node.data.length;
    }
    return {
      absoluteOffset,
      expectedStart,
      expectedEnd,
      hitContentId:
        (document.elementFromPoint(x, y)?.closest('[data-vecto-content]') as HTMLElement | null)
          ?.dataset.vectoContent ?? null,
      expectedContentId,
    };
  }, target);
}

/**
 * CTX-0019: at the current DPR/zoom, does the DOM selection box overlap the
 * canvas glyphs? Selects a literal substring in an entity's projection, unions
 * the Range client rects, and compares against the canvas extent of the same
 * substring (from the fillText trace) in the same client space. Returns the
 * horizontal delta so the caller can assert it stays sub-glyph across scales.
 */
async function selectionVsCanvas(
  page: Page,
  entityKey: 'text' | 'rich',
): Promise<{
  domLeft: number;
  domRight: number;
  canvasLeft: number;
  canvasRight: number;
}> {
  return page.evaluate(
    ({ entityKey }) => {
      const app = (window as any).__vecto;
      const entity = app[entityKey];
      const canvas = app.scene.canvas as HTMLCanvasElement;
      const canvasBox = canvas.getBoundingClientRect();
      const logicalW = app.scene.width || canvasBox.width;
      // Client px per logical px (folds in DPR *and* CSS zoom uniformly).
      const scale = canvasBox.width / logicalW;

      // Select the WHOLE first projected line. The plain-LTR fast path draws a
      // whole line per fillText, so there is no per-glyph canvas x — compare the
      // line's full extent instead, which still exercises the lines-path origin
      // and width under DPR/zoom.
      const root = app.scene.getContentElement(entity.id) as HTMLElement;
      const lineEl = root.children[0] as HTMLElement;
      const lineText = (lineEl.textContent ?? '').replace(/\n$/, '');
      const range = document.createRange();
      range.selectNodeContents(lineEl);
      let domLeft = Infinity;
      let domRight = -Infinity;
      for (const r of range.getClientRects()) {
        domLeft = Math.min(domLeft, r.left);
        domRight = Math.max(domRight, r.right);
      }

      // Canvas extent of that same line from the fillText trace. Trace x is
      // ENTITY-LOCAL logical px; add the entity's world origin (its scene x) and
      // the canvas box origin, scaled, to reach the same client space as the DOM
      // rect. The line's own left offset within the entity is already in the
      // trace x, so use the entity origin, not the projection line's left.
      const origin = app.scene.getContentElement(entity.id) as HTMLElement;
      const originLeft = origin.getBoundingClientRect().left;
      const lineLocalLeft = Number.parseFloat(lineEl.style.left || '0px') || 0;
      const trace = ((window as any).__vectoFillTrace ?? []) as Array<{
        text: string;
        x: number;
        width: number;
      }>;
      let cl = Infinity;
      let cr = -Infinity;
      for (const entry of trace) {
        if (entry.text.trim() !== lineText.trim()) continue;
        cl = Math.min(cl, entry.x);
        cr = Math.max(cr, entry.x + entry.width);
      }
      // The projection line box sits at originLeft (which already includes the
      // entity world x). Canvas trace x for a line equals the line's local left,
      // so client = originLeft + (traceX - lineLocalLeft) * scale.
      return {
        domLeft,
        domRight,
        canvasLeft: originLeft + (cl - lineLocalLeft) * scale,
        canvasRight: originLeft + (cr - lineLocalLeft) * scale,
      };
    },
    { entityKey },
  );
}

async function dragStandaloneTableCell(page: Page): Promise<{
  text: string;
  hitContentId: string | null;
  expectedContentId: string;
  mouseDownContentId: string | null;
}> {
  await page.evaluate(() => {
    (window as any).__vectoTableMouseDownContentId = null;
    document.addEventListener(
      'mousedown',
      (event) => {
        (window as any).__vectoTableMouseDownContentId =
          (
            (event.target as HTMLElement | null)?.closest(
              '[data-vecto-content]',
            ) as HTMLElement | null
          )?.dataset.vectoContent ?? null;
      },
      { once: true, capture: true },
    );
  });
  const target = await page.evaluate(() => {
    const app = (window as any).__vecto;
    const cell = app.table.children.find(
      (candidate: any) => candidate.getContentProjection?.()?.text === 'Alpha',
    );
    const root = app.scene.getContentElement(cell.id) as HTMLElement;
    const line = root.children[0];
    const textRange = document.createRange();
    textRange.selectNodeContents(line);
    const textRect = textRange.getBoundingClientRect();
    const x = textRect.left + textRect.width / 2;
    const y = textRect.top + textRect.height / 2;
    const hit = document.elementFromPoint(x, y) as HTMLElement | null;
    return {
      start: { x: textRect.left + 1, y },
      end: { x: textRect.right - 1, y },
      hitContentId:
        (hit?.closest('[data-vecto-content]') as HTMLElement | null)?.dataset.vectoContent ?? null,
      expectedContentId: cell.id,
    };
  });
  await page.mouse.move(target.start.x, target.start.y);
  await page.mouse.down();
  await page.mouse.move(target.end.x, target.end.y, { steps: 6 });
  await page.mouse.up();
  return {
    text: await page.evaluate(() => getSelection()?.toString() ?? ''),
    hitContentId: target.hitContentId,
    expectedContentId: target.expectedContentId,
    mouseDownContentId: await page.evaluate(
      () => (window as any).__vectoTableMouseDownContentId ?? null,
    ),
  };
}

/**
 * Verify the per-child a11y hotspots added for `TreeView` and `ContextMenu`
 * (#191) in a REAL browser. Two things only a real browser can settle:
 *
 *  1. the hotspots are actually projected with their roles + a single roving
 *     tab stop (jsdom can confirm the attributes, not that the browser accepts
 *     the resulting tree);
 *  2. they do **not** steal the pointer. They carry `pointerEvents: 'none'`
 *     precisely so the component underneath keeps its own mouse handling —
 *     `elementFromPoint` over a row must therefore NOT land on the hotspot.
 *     This is the same class of regression CI caught for Table cells.
 */
async function probeChildRoleHotspots(page: Page): Promise<{
  treeitemRoles: number;
  treeitemTabStops: number;
  menuitemRoles: number;
  menuitemTabStops: number;
  menuitemHaspopup: number;
  treeHotspotOwnsPointer: boolean;
  menuHotspotOwnsPointer: boolean;
}> {
  const result = await page.evaluate(() => {
    const app = (window as any).__vecto;
    // Open the menu only for the duration of this probe: while shown it installs
    // a full-scene interactive backdrop (outside-click catcher) that would
    // intercept every other pointer drag in this fixture.
    app.contextMenu.showAtPoint(880, 860);
    app.scene.render((app.scene as any).renderer, 16, 16);
    (app.scene as any).syncA11y((app.scene as any).root);

    const root = app.scene.a11yRoot as HTMLElement;
    const all = (sel: string) => Array.from(root.querySelectorAll<HTMLElement>(sel));

    const treeitems = all('[role="treeitem"]');
    const menuitems = all('[role="menuitem"]');
    const tabStops = (els: HTMLElement[]) => els.filter((e) => e.tabIndex === 0).length;

    /** Does elementFromPoint over the element's centre land on the hotspot? */
    const ownsPointer = (el: HTMLElement | undefined): boolean => {
      if (!el) return false;
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return false;
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return hit === el;
    };

    return {
      treeitemRoles: treeitems.length,
      treeitemTabStops: tabStops(treeitems),
      menuitemRoles: menuitems.length,
      menuitemTabStops: tabStops(menuitems),
      menuitemHaspopup: menuitems.filter((e) => e.getAttribute('aria-haspopup') === 'menu').length,
      treeHotspotOwnsPointer: ownsPointer(treeitems[0]),
      menuHotspotOwnsPointer: ownsPointer(menuitems[0]),
    };
  });

  // Close it again and let the projection settle, so the backdrop is gone before
  // any later drag runs.
  await page.evaluate(() => {
    const app = (window as any).__vecto;
    app.contextMenu.hide();
    app.scene.render((app.scene as any).renderer, 16, 16);
    (app.scene as any).syncA11y((app.scene as any).root);
  });
  return result;
}

async function dragMarkdownProjection(
  page: Page,
  projectedText: string,
): Promise<{
  text: string;
  expectedContentId: string;
  mouseDownContentId: string | null;
}> {
  await page.evaluate(() => {
    (window as any).__vectoMarkdownMouseDownContentId = null;
    document.addEventListener(
      'mousedown',
      (event) => {
        (window as any).__vectoMarkdownMouseDownContentId = (
          (event.target as HTMLElement | null)?.closest(
            '[data-vecto-content]',
          ) as HTMLElement | null
        )?.dataset.vectoContent;
      },
      { once: true, capture: true },
    );
  });
  const target = await page.evaluate((projectedText) => {
    const app = (window as any).__vecto;
    const descendants = (entity: any): any[] =>
      entity.children.flatMap((child: any) => [child, ...descendants(child)]);
    const entity = descendants(app.markdown).find(
      (candidate) => candidate.getContentProjection?.()?.text === projectedText,
    );
    if (!entity) throw new Error(`Missing Markdown projection ${projectedText}`);
    const root = app.scene.getContentElement(entity.id) as HTMLElement;
    const range = document.createRange();
    range.selectNodeContents(root.children[0] ?? root);
    const rect = range.getBoundingClientRect();
    return {
      expectedContentId: entity.id,
      start: { x: rect.left + 1, y: rect.top + rect.height / 2 },
      end: { x: rect.right - 1, y: rect.top + rect.height / 2 },
    };
  }, projectedText);
  await page.mouse.move(target.start.x, target.start.y);
  await page.mouse.down();
  await page.mouse.move(target.end.x, target.end.y, { steps: 12 });
  await page.mouse.up();
  return page.evaluate((expectedContentId) => {
    return {
      text: getSelection()?.toString() ?? '',
      expectedContentId,
      mouseDownContentId: (window as any).__vectoMarkdownMouseDownContentId ?? null,
    };
  }, target.expectedContentId);
}

async function verifyCase(browserCase: BrowserCase, url: string): Promise<void> {
  const browser: Browser = await puppeteer.launch({
    browser: browserCase.browser,
    executablePath: browserCase.executablePath,
    headless: true,
    args: browserCase.browser === 'chrome' ? ['--no-sandbox', '--disable-gpu'] : [],
    defaultViewport: {
      width: 1200,
      height: 1400,
      deviceScaleFactor: browserCase.dpr,
    },
    extraPrefsFirefox: browserCase.extraPrefsFirefox,
  });

  try {
    try {
      await browser
        .defaultBrowserContext()
        .overridePermissions(url, ['clipboard-read', 'clipboard-write']);
    } catch {
      // Firefox does not expose Chromium's permission override surface. Its
      // headless clipboard still accepts the real keyboard commands below.
    }
    const page = await browser.newPage();
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    await instrumentCanvas(page);
    await page.goto(`${url}?case=${encodeURIComponent(browserCase.name)}`, {
      waitUntil: 'networkidle0',
    });
    await page.waitForFunction('window.__ready === true', { timeout: 10_000 });
    if (browserCase.zoom) {
      const calibrationBeforeZoom = await page.evaluate(() => {
        const app = (window as any).__vecto;
        return app.scene.getContentElement(app.code.id)?.dataset.vectoGridCalibration ?? '';
      });
      await page.evaluate((zoom) => {
        document.body.style.zoom = String(zoom);
        // CSS zoom is used here to reproduce fractional browser scaling in
        // both engines. This fixture disables automatic window resize, so it
        // mirrors the application's required explicit viewport notification.
        const app = (window as any).__vecto;
        app.scene.resize(app.scene.width, app.scene.height);
      }, browserCase.zoom);
      await page.waitForFunction(
        (previous) => {
          const app = (window as any).__vecto;
          const root = app.scene.getContentElement(app.code.id);
          return (
            root?.dataset.vectoGridReady === 'true' &&
            root.dataset.vectoGridCalibration !== previous
          );
        },
        {},
        calibrationBeforeZoom,
      );
    }
    await page.waitForFunction(() => {
      const app = (window as any).__vecto;
      return [app?.code, app?.transformedCode, app?.largeCode].every(
        (entity) =>
          entity && app.scene.getContentElement(entity.id)?.dataset.vectoGridReady === 'true',
      );
    });
    const steadyGridReads = await page.evaluate(async () => {
      await document.fonts?.ready;
      const app = (window as any).__vecto;
      const root = app.scene.getContentElement(app.code.id) as HTMLElement;
      const firstCell = root.querySelector('[data-vecto-grid-cell]');
      const expectedCells = app.code
        .getContentProjection()
        .grid.lines.reduce((total: number, line: any) => total + line.cells.length, 0);
      const observer = new MutationObserver(() => undefined);
      observer.observe(root, {
        attributes: true,
        characterData: true,
        childList: true,
        subtree: true,
      });
      (window as any).__vectoResetRangeGeometryReads();
      app.scene.markDirty();
      await new Promise<void>((done) =>
        requestAnimationFrame(() => requestAnimationFrame(() => done())),
      );
      const result = {
        reads: { ...(window as any).__vectoRangeGeometryReads },
        mutationRecords: observer.takeRecords().length,
        sameFirstCell: firstCell === root.querySelector('[data-vecto-grid-cell]'),
        carrierCount: root.querySelectorAll('[data-vecto-grid-cell]').length,
        expectedCells,
      };
      observer.disconnect();
      return result;
    });
    assert.deepEqual(
      steadyGridReads.reads,
      { bounding: 0, clientRects: 0 },
      `${browserCase.name} prepared grid must not read Range geometry during steady projection sync`,
    );
    assert.equal(steadyGridReads.mutationRecords, 0, `${browserCase.name} steady grid mutated DOM`);
    assert.equal(steadyGridReads.sameFirstCell, true, `${browserCase.name} replaced grid carriers`);
    assert.equal(
      steadyGridReads.carrierCount,
      steadyGridReads.expectedCells,
      `${browserCase.name} omitted prepared grid carriers`,
    );

    const result = await page.evaluate(() => {
      const app = (window as any).__vecto;
      /**
       * Selection rectangles a projected hard break contributes, across every
       * content projection on the page.
       *
       * A line carrier is `white-space: pre`, so a trailing `\n` written as
       * ordinary inline text is a real preserved character and the browser hands
       * it a selection rectangle of ZERO WIDTH and FULL LINE HEIGHT. Chrome
       * paints it, so selecting a line drew a caret-like vertical bar just past
       * the last glyph — ink the canvas never produced. Measured on a live page
       * before the fix, one paragraph line yielded four rects, the last
       * `x 495.18, w 0, h 31.82`; a `CodeBlock` fixture reported one on every
       * row that owned a break, including the empty row whose whole content is
       * the break.
       *
       * `brokenCopy` is the other half of the contract: the paint must be
       * suppressed WITHOUT dropping the character, or copy silently joins lines.
       */
      const breakSliverReport = () => {
        const roots = [...document.querySelectorAll<HTMLElement>('[data-vecto-content]')];
        let sliverCount = 0;
        let breakCarriers = 0;
        const worst: Array<{ text: string; x: number; height: number }> = [];

        for (const root of roots) {
          for (const line of [...root.children] as HTMLElement[]) {
            // Carrier lines only. A coarse-tier root holds one text node and has
            // no per-line break of its own.
            const isCarrier =
              line.dataset?.vectoGridLine !== undefined ||
              root.dataset.vectoProjectionLines !== undefined;
            if (!isCarrier) continue;
            const text = line.textContent ?? '';
            if (!/[\r\n]/.test(text)) continue;
            // A break that survived as its own collapsed carrier, which is what
            // keeps it selectable and copyable while contributing no line box.
            for (const child of [...line.querySelectorAll<HTMLElement>('span')]) {
              if (/^[\r\n]+$/.test(child.textContent ?? '')) breakCarriers++;
            }
            const range = document.createRange();
            range.selectNodeContents(line);
            const seen = new Set<string>();
            for (const rect of range.getClientRects()) {
              const key = `${rect.left.toFixed(2)}/${rect.top.toFixed(2)}/${rect.width.toFixed(2)}/${rect.height.toFixed(2)}`;
              if (seen.has(key)) continue;
              seen.add(key);
              if (rect.width === 0 && rect.height > 1) {
                sliverCount++;
                if (worst.length < 6) {
                  worst.push({
                    text: text.replace(/\n/g, '\\n').slice(0, 24),
                    x: Number(rect.left.toFixed(2)),
                    height: Number(rect.height.toFixed(2)),
                  });
                }
              }
            }
          }
        }
        return { rootCount: roots.length, sliverCount, breakCarriers, worst };
      };
      const rectangle = (value: DOMRect) => ({
        x: value.x,
        y: value.y,
        width: value.width,
        height: value.height,
      });
      const projected = (entity: any, line: number) =>
        app.lineBaseline(app.scene.getContentElement(entity.id), line);
      const expectedBaseline = (entity: any, line: number) => {
        const root = app.scene.getContentElement(entity.id) as HTMLElement;
        const lineElement = root.children[line] as HTMLElement;
        const lineRect = lineElement.getBoundingClientRect();
        const lineStyle = getComputedStyle(lineElement);
        const lineHeight = Number.parseFloat(lineStyle.lineHeight);
        const scale = lineHeight > 0 ? lineRect.height / lineHeight : 1;
        const projectionLine = entity.getContentProjection().lines[line];
        return (
          root.getBoundingClientRect().top + (projectionLine.y + projectionLine.baseline) * scale
        );
      };
      const selectionInfo = (entity: any) => {
        const root = app.scene.getContentElement(entity.id) as HTMLElement;
        const range = document.createRange();
        range.selectNodeContents(root);
        const selection = getSelection()!;
        selection.removeAllRanges();
        selection.addRange(range);
        const rectangles = [...range.getClientRects()]
          .filter((item) => item.width > 0.01 && item.height > 0.01)
          .map(rectangle);
        const lineRectangles = [...root.children].map((line) =>
          rectangle(line.getBoundingClientRect()),
        );
        const overlapsLine = (
          item: { y: number; height: number },
          line: { y: number; height: number },
        ) => item.y < line.y + line.height + 1 && item.y + item.height > line.y - 1;
        const duplicate = rectangles.some((item, index) =>
          rectangles
            .slice(index + 1)
            .some(
              (candidate) =>
                Math.abs(item.x - candidate.x) <= 0.25 &&
                Math.abs(item.y - candidate.y) <= 0.25 &&
                Math.abs(item.width - candidate.width) <= 0.25 &&
                Math.abs(item.height - candidate.height) <= 0.25,
            ),
        );
        return {
          text: selection.toString(),
          textContent: root.textContent,
          elementChildrenOnly: [...root.childNodes].every(
            (child) => child.nodeType === Node.ELEMENT_NODE,
          ),
          root: rectangle(root.getBoundingClientRect()),
          lines: lineRectangles,
          rectangles,
          rowCount: lineRectangles.filter((line) =>
            rectangles.some((item) => overlapsLine(item, line)),
          ).length,
          unmappedRectangles: rectangles.filter(
            (item) => !lineRectangles.some((line) => overlapsLine(item, line)),
          ),
          duplicate,
          direction: [...root.children].map((line) => (line as HTMLElement).dir),
          color: getComputedStyle(root).color,
          textFill: getComputedStyle(root).getPropertyValue('-webkit-text-fill-color'),
          forcedColorAdjust: getComputedStyle(root).forcedColorAdjust,
        };
      };
      const descendants = (entity: any): any[] =>
        entity.children.flatMap((child: any) => [child, ...descendants(child)]);
      const contentTexts = (entities: any[]) =>
        entities
          .map((entity) => app.scene.getContentElement(entity.id)?.textContent)
          .filter((text): text is string => typeof text === 'string' && text.length > 0);

      const controls = document.createElement('div');
      controls.style.cssText =
        'position:absolute;left:-10000px;top:0;white-space:pre;font:32px "Noto Serif",serif;font-kerning:normal';
      const ligatures = document.createElement('span');
      ligatures.style.fontVariantLigatures = 'normal';
      ligatures.textContent = 'office affinity ffi';
      const noLigatures = document.createElement('span');
      noLigatures.style.fontVariantLigatures = 'none';
      noLigatures.textContent = 'office affinity ffi';
      controls.append(ligatures, document.createElement('br'), noLigatures);
      document.body.appendChild(controls);

      const trace = ((window as any).__vectoFillTrace ?? []) as Array<{
        text: string;
        x: number;
        y: number;
        font: string;
        width: number;
        left: number;
        right: number;
        a: number;
        b: number;
        c: number;
        d: number;
      }>;
      const codeTrace = [
        ...new Map(
          trace
            .filter(
              (entry) =>
                entry.font.startsWith('15px') &&
                entry.y >= 30 &&
                entry.y <= 130 &&
                Math.abs(entry.b) <= 0.001 &&
                Math.abs(entry.c) <= 0.001,
            )
            .map((entry) => [
              `${entry.text}\u0000${entry.x}\u0000${entry.y}\u0000${entry.font}`,
              entry,
            ]),
        ).values(),
      ].sort((a, b) => a.y - b.y || a.x - b.x);
      const overlaps: number[] = [];
      const overlapDetails: Array<{
        previous: string;
        current: string;
        overlap: number;
        y: number;
      }> = [];
      for (let index = 1; index < codeTrace.length; index++) {
        const previous = codeTrace[index - 1];
        const current = codeTrace[index];
        if (current.y !== previous.y) continue;
        const previousEnd = previous.x + previous.right;
        const currentStart = current.x - current.left;
        const overlap = Math.max(0, previousEnd - currentStart);
        // Contextually shaped Arabic presentation forms intentionally share
        // joining strokes. The collision invariant targets independent code
        // cells (ASCII/CJK/emoji), where overlap is visual corruption.
        if (/[\uFE70-\uFEFF]/u.test(previous.text + current.text)) continue;
        overlaps.push(overlap);
        if (overlap > 0) {
          overlapDetails.push({
            previous: previous.text,
            current: current.text,
            overlap,
            y: current.y,
          });
        }
      }
      const ligatureTrace = trace.find((entry) => entry.text === 'office affinity ffi');
      const rtlTrace = trace.filter(
        (entry) =>
          entry.font.startsWith('24px') &&
          (entry.text.includes('VectoJS') ||
            /[\uFE70-\uFEFF]/u.test(entry.text) ||
            /[\u0600-\u06FF\u0041-\u007A]/u.test(entry.text)),
      );
      // RTL text now renders glyph-by-glyph (each fillText is one glyph, so the
      // engine can right-align + visually reorder the line). Reconstruct each
      // visual line's width from its glyphs' x-extent — the rightmost glyph end
      // minus the leftmost glyph start — and take the widest line, matching how
      // the DOM line box measures the whole run.
      const rtlByLine = new Map<number, { min: number; max: number }>();
      for (const entry of rtlTrace) {
        const key = Math.round(entry.y);
        const span = rtlByLine.get(key) ?? { min: Infinity, max: -Infinity };
        span.min = Math.min(span.min, entry.x);
        span.max = Math.max(span.max, entry.x + entry.width);
        rtlByLine.set(key, span);
      }
      const rtlCanvasWidth = Math.max(
        0,
        ...[...rtlByLine.values()].map((span) => span.max - span.min),
      );
      const rtlProjection = app.scene.getContentElement(app.rtl.id) as HTMLElement;
      const rtlDomWidth = Math.max(
        0,
        ...[...rtlProjection.children].map((line) => {
          const element = line as HTMLElement;
          const rect = element.getBoundingClientRect();
          const lineHeight = Number.parseFloat(getComputedStyle(element).lineHeight);
          const scale = lineHeight > 0 ? rect.height / lineHeight : 1;
          return rect.width / scale;
        }),
      );
      const codeProjection = app.scene.getContentElement(app.code.id) as HTMLElement;
      const codePreparedLines = app.code.getContentProjection().grid.lines;
      const codeTraceRows = [...new Set(codeTrace.map((entry) => entry.y))].map((y) =>
        codeTrace.filter((entry) => entry.y === y),
      );
      const codeCellWidth = codeTraceRows[0][1].x - codeTraceRows[0][0].x;
      const codeGrid = [...codeProjection.children].map((line, index) => {
        const lineElement = line as HTMLElement;
        const lineRect = lineElement.getBoundingClientRect();
        const localWidth = Number.parseFloat(lineElement.style.width);
        const scale = localWidth > 0 ? lineRect.width / localWidth : 1;
        const cells = [...lineElement.querySelectorAll<HTMLElement>('[data-vecto-grid-cell]')].map(
          (cell) => {
            const sourceLength = Number(cell.dataset.vectoGridSourceLength);
            const target = Number(cell.dataset.vectoGridAdvance);
            const range = document.createRange();
            range.setStart(cell.firstChild!, 0);
            range.setEnd(cell.firstChild!, sourceLength);
            const rect = range.getBoundingClientRect();
            return {
              source: cell.textContent?.slice(0, sourceLength) ?? '',
              target,
              rectWidth: rect.width,
              transform: cell.style.transform,
              startError: Math.abs(
                rect.left - (lineRect.left + Number(cell.dataset.vectoGridX) * scale),
              ),
              widthError: Math.abs(rect.width - target * scale),
            };
          },
        );
        // Selection SEAM residue: does the browser's own selection rect for one
        // cell reach the rect of the next?
        //
        // Distinct from `widthError` above, which compares a rect against the
        // grid's expected width. This compares consecutive rects against EACH
        // OTHER, which is what a reader sees: a residue here is literally the
        // width of the unhighlighted column between two adjacent glyphs. The
        // page-scale calibration basis used to be measured over 1 px, where a
        // browser's 1/64-device-px rect rounding is the whole reading, and the
        // resulting 0.78% scale error left 0.133 px at every CJK seam on a real
        // page — which paints as a vertical white line at DPR 1.1.
        const seamResidues: Array<{ left: string; right: string; residue: number }> = [];
        const cellElements = [
          ...lineElement.querySelectorAll<HTMLElement>('[data-vecto-grid-cell]'),
        ];
        for (let cellIndex = 1; cellIndex < cellElements.length; cellIndex++) {
          const previous = cellElements[cellIndex - 1];
          const current = cellElements[cellIndex];
          const previousLength = Number(previous.dataset.vectoGridSourceLength);
          const currentLength = Number(current.dataset.vectoGridSourceLength);
          if (previousLength <= 0 || currentLength <= 0) continue;
          // Zero-advance cells (bidi controls) share an x with their neighbour and
          // have no seam of their own.
          if (
            Number(previous.dataset.vectoGridAdvance) <= 0 ||
            Number(current.dataset.vectoGridAdvance) <= 0
          ) {
            continue;
          }
          // Only same-direction neighbours: across a bidi boundary the visually
          // adjacent pair is not the logically adjacent one, so a "gap" there is
          // reordering rather than residue.
          if (previous.dataset.vectoGridLevel !== current.dataset.vectoGridLevel) continue;
          const previousRange = document.createRange();
          previousRange.setStart(previous.firstChild!, 0);
          previousRange.setEnd(previous.firstChild!, previousLength);
          const currentRange = document.createRange();
          currentRange.setStart(current.firstChild!, 0);
          currentRange.setEnd(current.firstChild!, currentLength);
          const previousRect = previousRange.getBoundingClientRect();
          const currentRect = currentRange.getBoundingClientRect();
          if (previousRect.width <= 0 || currentRect.width <= 0) continue;
          const rtl = (Number(previous.dataset.vectoGridLevel) & 1) !== 0;
          const residue = rtl
            ? previousRect.left - currentRect.right
            : currentRect.left - previousRect.right;
          seamResidues.push({
            left: previous.textContent?.slice(0, previousLength) ?? '',
            right: current.textContent?.slice(0, currentLength) ?? '',
            residue,
          });
        }
        return {
          domWidth: lineRect.width,
          localWidth,
          expectedWidth: codePreparedLines[index].width,
          details: cells,
          maxStartError: Math.max(0, ...cells.map((cell) => cell.startError)),
          maxWidthError: Math.max(0, ...cells.map((cell) => cell.widthError)),
          scale,
          seamResidues,
          maxSeamResidue: Math.max(0, ...seamResidues.map((seam) => Math.abs(seam.residue))),
          // A COPY, not the array element itself. Returning the same object
          // reference twice in one `page.evaluate` result made the duplicate
          // deserialize as `undefined`, so the failure message read
          // `... residue 0.2666px undefined` — the number was right and the
          // evidence for it was missing.
          worstSeam:
            seamResidues.length > 0
              ? {
                  ...seamResidues.reduce((worst, seam) =>
                    Math.abs(seam.residue) > Math.abs(worst.residue) ? seam : worst,
                  ),
                }
              : null,
        };
      });

      const text = selectionInfo(app.text);
      const code = selectionInfo(app.code);
      const rich = selectionInfo(app.rich);
      const rtl = selectionInfo(app.rtl);
      const ligature = selectionInfo(app.ligature);
      const markdownEntities = descendants(app.markdown).filter(
        (entity) => entity.getContentProjection?.() !== null,
      );
      const tableEntities = app.table.children.filter(
        (entity: any) => entity.getContentProjection?.() !== null,
      );
      const areaElement = app.scene.getA11yElement(app.area.id) as HTMLTextAreaElement;
      const areaStyle = getComputedStyle(areaElement);
      const ligatureProjectionLine = (app.scene.getContentElement(app.ligature.id) as HTMLElement)
        .children[0] as HTMLElement;
      const ligatureProjectionRect = ligatureProjectionLine.getBoundingClientRect();
      const ligatureProjectionLineHeight = Number.parseFloat(
        getComputedStyle(ligatureProjectionLine).lineHeight,
      );
      const ligatureProjectionScale =
        ligatureProjectionLineHeight > 0
          ? ligatureProjectionRect.height / ligatureProjectionLineHeight
          : 1;

      // CTX-0243: the baseline-shifted run must draw 4px above the runs beside
      // it (its own baseline, not the shared one) while staying in ONE projected
      // line whose DOM text reads H2O. Keyed by the exact font shorthand so other
      // entities' draws can never alias into the delta.
      const shiftTrace = ((window as any).__vectoFillTrace ?? []) as Array<{
        text: string;
        x: number;
        y: number;
        font: string;
      }>;
      const drawY = (text: string, font: string): number[] =>
        // The scene re-renders every rAF, so each glyph draws once per frame with
        // identical coordinates; report all occurrences (several per browser case)
        // and let the assertions below pick the last.
        shiftTrace
          .filter((entry) => entry.text === text && entry.font === font)
          .map((entry) => entry.y);
      const shiftedProjection = app.shiftedRich.getContentProjection?.();
      const shiftedDom = app.scene.getContentElement(app.shiftedRich.id) as HTMLElement | null;

      return {
        baselines: {
          text: {
            actual: projected(app.text, 0),
            expected: expectedBaseline(app.text, 0),
          },
          code: {
            actual: projected(app.code, 1),
            expected: expectedBaseline(app.code, 1),
          },
          rich: {
            actual: projected(app.rich, 0),
            expected: expectedBaseline(app.rich, 0),
          },
        },
        selection: { text, code, rich, rtl, ligature },
        markdownTexts: contentTexts(markdownEntities),
        tableTexts: contentTexts(tableEntities),
        textarea: {
          font: areaStyle.font,
          lineHeight: areaStyle.lineHeight,
          padding: areaStyle.padding,
          boxSizing: areaStyle.boxSizing,
        },
        ligature: {
          normalWidth: ligatures.getBoundingClientRect().width,
          disabledWidth: noLigatures.getBoundingClientRect().width,
          domWidth: ligatureProjectionRect.width / ligatureProjectionScale,
          canvasWidth: ligatureTrace?.width ?? 0,
        },
        rtlWidths: { dom: rtlDomWidth, canvas: rtlCanvasWidth },
        codeGrid: { cellWidth: codeCellWidth, lines: codeGrid },
        maxCodeOverlap: Math.max(0, ...overlaps),
        codeOverlapDetails: overlapDetails,
        shiftedRich: {
          hY: drawY('H', '20px serif'),
          twoY: drawY('2', '12px serif'),
          oY: drawY('O', '20px serif'),
          projLines: shiftedProjection?.lines?.length ?? -1,
          projText: shiftedProjection?.text ?? '',
          domText: shiftedDom?.textContent ?? '',
        },
        breakSlivers: breakSliverReport(),
      };
    });

    await page.evaluate(() => {
      const app = (window as any).__vecto;
      const code = app.scene.getContentElement(app.code.id) as HTMLElement;
      const range = document.createRange();
      range.selectNodeContents(code);
      const selection = getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
      const sink = document.createElement('textarea');
      sink.id = 'clipboard-sink';
      sink.style.cssText = 'position:fixed;left:0;bottom:0;width:200px;height:80px';
      document.body.appendChild(sink);
    });
    await page.keyboard.down('Control');
    await page.keyboard.press('c');
    await page.keyboard.up('Control');
    await page.focus('#clipboard-sink');
    await page.keyboard.down('Control');
    await page.keyboard.press('v');
    await page.keyboard.up('Control');
    const pastedCode = await page.$eval(
      '#clipboard-sink',
      (element) => (element as HTMLTextAreaElement).value,
    );
    const forwardBlankDrag = await dragAcrossCodeBlankRegions(page, false);
    const reverseBlankDrag = await dragAcrossCodeBlankRegions(page, true);
    const childRoleHotspots = await probeChildRoleHotspots(page);
    const tableCellDrag = await dragStandaloneTableCell(page);
    const markdownListDrag = await dragMarkdownProjection(page, '• Item A');
    const markdownTableDrag = await dragMarkdownProjection(page, 'Alpha');
    const emojiStart = await clickGridSource(page, 'transformedCode', '👩‍💻', 0.1);
    const emojiEnd = await clickGridSource(page, 'transformedCode', '👩‍💻', 0.9);
    const lamAlefVisualStart = await clickGridSource(page, 'transformedCode', 'لا', 0.1);
    const lamAlefVisualMiddle = await clickGridSource(page, 'transformedCode', 'لا', 0.5);
    const lamAlefVisualEnd = await clickGridSource(page, 'transformedCode', 'لا', 0.9);
    const rtlLeftEdge = await clickProjectionEdge(page, 'rtl', 'left');
    const rtlRightEdge = await clickProjectionEdge(page, 'rtl', 'right');
    const rotatedTextEarly = await clickOrdinarySource(page, 'rotatedText', 'd');
    const rotatedTextLate = await clickOrdinarySource(page, 'rotatedText', 'y');
    const mirroredRichEarly = await clickOrdinarySource(page, 'mirroredRich', 'h');
    const mirroredRichLate = await clickOrdinarySource(page, 'mirroredRich', 't');
    const flowProjectionEarly = await clickOrdinarySource(page, 'flowProjection', 'α');
    const flowProjectionLate = await clickOrdinarySource(page, 'flowProjection', 'Ω');
    // CTX-0019: DOM selection box vs canvas glyphs for the plain-LTR Text line
    // path, at whatever DPR/zoom this browserCase runs — the projection-vs-canvas
    // subpixel-drift check that fractional scale is most likely to break.
    const textSelVsCanvas = await selectionVsCanvas(page, 'text');
    const doubleClickWord = await clickGridSource(page, 'code', 'f', 0.5, 2);
    const tripleClickLine = await clickGridSource(page, 'transformedCode', 'لا', 0.5, 3);
    await clickGridSource(page, 'code', 'o', 0.1);
    const shiftExtended = await clickGridSource(page, 'code', '好', 0.9, 1, true);
    await clickGridSource(page, 'transformedCode', 'a', 0.1);
    const mixedBidiExtended = await clickGridSource(page, 'transformedCode', '3', 0.9, 1, true);

    for (const [name, values] of Object.entries(result.baselines)) {
      assert.ok(
        Math.abs(values.actual - values.expected) <= 1,
        `${browserCase.name} ${name} baseline expected ${values.expected}, got ${values.actual}`,
      );
    }
    // CTX-0243: baseline shift. The '2' run draws on its OWN baseline — exactly
    // `shift` above the 20px runs beside it — yet stays inside the single
    // projected line (and its DOM text) that holds H2O. The delta is invariant
    // under DPR/zoom because it is a difference of two draws in the same frame.
    {
      const s = result.shiftedRich;
      assert.ok(
        s.hY.length >= 1 && s.twoY.length >= 1 && s.oY.length >= 1,
        `${browserCase.name} shiftedRich drew ${JSON.stringify(s)}`,
      );
      assert.ok(
        Math.abs(s.hY.at(-1)! - s.twoY.at(-1)! - 4) <= 0.5,
        `${browserCase.name} '2' must draw 4px above H (got ${s.hY.at(-1)} vs ${s.twoY.at(-1)})`,
      );
      assert.ok(
        Math.abs(s.hY.at(-1)! - s.oY.at(-1)!) <= 0.5,
        `${browserCase.name} H and O share one baseline (got ${s.hY.at(-1)} vs ${s.oY.at(-1)})`,
      );
      assert.equal(
        s.projLines,
        1,
        `${browserCase.name} shifted run must stay in its line's projection`,
      );
      assert.equal(s.projText, 'H2O', `${browserCase.name} projection text must read H2O`);
      assert.equal(s.domText, 'H2O', `${browserCase.name} DOM text must read H2O`);
    }
    // CTX-0019: the selection box must overlap the drawn glyphs at this DPR/zoom.
    // Both rects are in client px; the tolerance is a few client px to absorb
    // browser text-measure vs canvas-advance rounding, which is what fractional
    // DPR/zoom amplifies. Left edges especially must line up (start-of-selection).
    {
      const sc = textSelVsCanvas;
      // Left edge (selection start) must line up tightly — this is the origin
      // the whole lines-path geometry hangs off, and what fractional DPR/zoom
      // would shift. The right edge accumulates the whole line's kerned-vs-
      // advance width delta, so allow a small relative slack there.
      assert.ok(
        Math.abs(sc.domLeft - sc.canvasLeft) <= 2,
        `${browserCase.name} Text selection left drifts from canvas ${JSON.stringify(sc)}`,
      );
      // The width delta grows under fractional zoom (browser kerned line vs
      // canvas advance sum) — a measurement artifact, not a selection break: the
      // left origin above stays exact, so the selection START tracks the glyphs
      // at every scale. The divergence is engine-specific: ~5% on Chrome, but
      // larger on Firefox/Gecko under zoom (its kerned line measure diverges more
      // from the per-glyph advance sum — the same reason its RTL width needed a
      // looser bound). Allow 12% on Firefox, 8% on Chrome.
      const widthPct = browserCase.browser === 'firefox' ? 0.12 : 0.08;
      const rightTol = Math.max(4, (sc.canvasRight - sc.canvasLeft) * widthPct);
      assert.ok(
        Math.abs(sc.domRight - sc.canvasRight) <= rightTol,
        `${browserCase.name} Text selection right drifts from canvas ${JSON.stringify(sc)}`,
      );
    }
    assert.match(result.textarea.font, /16px/);
    const textareaLineHeight = Number.parseFloat(result.textarea.lineHeight);
    assert.ok(
      Math.min(Math.abs(textareaLineHeight - 22.4), Math.abs(textareaLineHeight - 20.16)) <= 0.05,
      `${browserCase.name} textarea line-height ${result.textarea.lineHeight}`,
    );
    const textareaPadding = Number.parseFloat(result.textarea.padding);
    assert.ok(
      Math.min(Math.abs(textareaPadding - 10), Math.abs(textareaPadding - 9)) <= 0.05,
      `${browserCase.name} textarea padding ${result.textarea.padding}`,
    );
    assert.equal(result.textarea.boxSizing, 'border-box');

    const expected = {
      text: 'alpha beta gamma delta epsilon zeta eta theta',
      code: 'office ffi\n你好\nA👩‍💻B\nمرحبا',
      rich: 'small office مرحبا VectoJS',
      rtl: 'مرحبا بك في VectoJS',
      ligature: 'office affinity ffi',
    };
    assert.equal(
      pastedCode,
      expected.code,
      `${browserCase.name} real keyboard copy/paste preserves CodeBlock source`,
    );
    for (const [direction, drag] of [
      ['forward', forwardBlankDrag],
      ['reverse', reverseBlankDrag],
    ] as const) {
      assert.equal(
        drag.text,
        'office ffi\n你好',
        `${browserCase.name} ${direction} blank-region drag preserves the first two code rows ${JSON.stringify(drag)}`,
      );
      assert.equal(
        drag.rootPointerEvents,
        'none',
        `${browserCase.name} ${direction} blank-region drag restores overlay routing`,
      );
      assert.deepEqual(
        drag.rangeGeometryReads,
        { bounding: 0, clientRects: 0 },
        `${browserCase.name} ${direction} prepared-grid drag performed Range geometry reads`,
      );
    }
    assert.deepEqual(
      {
        forward: {
          anchor: forwardBlankDrag.anchor,
          anchorOffset: forwardBlankDrag.anchorOffset,
          focus: forwardBlankDrag.focus,
          focusOffset: forwardBlankDrag.focusOffset,
        },
        reverse: {
          anchor: reverseBlankDrag.anchor,
          anchorOffset: reverseBlankDrag.anchorOffset,
          focus: reverseBlankDrag.focus,
          focusOffset: reverseBlankDrag.focusOffset,
        },
      },
      {
        forward: {
          anchor: 'o',
          anchorOffset: 0,
          // The endpoint cell carries its cluster and NOTHING else. The row's
          // trailing hard break used to be appended to this same Text node
          // (making it `'好\n'`), which gave it a zero-width, full-height
          // selection rect that Chrome painted as a bar past the last glyph. The
          // break now lives in its own collapsed carrier — the offsets and the
          // dragged text above are unchanged.
          focus: '好',
          focusOffset: 1,
        },
        reverse: {
          anchor: '好',
          anchorOffset: 1,
          focus: 'o',
          focusOffset: 0,
        },
      },
      `${browserCase.name} preserves forward and reverse Selection direction`,
    );
    assert.equal(
      tableCellDrag.hitContentId,
      tableCellDrag.expectedContentId,
      `${browserCase.name} standalone Table cell projection owns the pointer hit`,
    );
    assert.equal(
      tableCellDrag.mouseDownContentId,
      tableCellDrag.expectedContentId,
      `${browserCase.name} standalone Table routes mousedown through its content projection`,
    );
    assert.equal(
      tableCellDrag.text,
      'Alpha',
      `${browserCase.name} standalone Table cell supports native pointer selection ${JSON.stringify(tableCellDrag)}`,
    );

    // Per-child a11y hotspots (#191) in a real browser. Previously jsdom-only.
    const hs = JSON.stringify(childRoleHotspots);
    assert.ok(
      childRoleHotspots.treeitemRoles === 2,
      // Fixture tree: 'Root node' (collapsed, so its child is not a row) + 'Leaf node'.
      `${browserCase.name} TreeView projects one role=treeitem per visible row ${hs}`,
    );
    assert.equal(
      childRoleHotspots.treeitemTabStops,
      1,
      `${browserCase.name} TreeView exposes exactly one roving tab stop ${hs}`,
    );
    assert.equal(
      childRoleHotspots.menuitemRoles,
      3,
      `${browserCase.name} ContextMenu projects one role=menuitem per non-separator item ${hs}`,
    );
    assert.equal(
      childRoleHotspots.menuitemTabStops,
      1,
      `${browserCase.name} ContextMenu exposes exactly one roving tab stop ${hs}`,
    );
    assert.equal(
      childRoleHotspots.menuitemHaspopup,
      1,
      `${browserCase.name} ContextMenu marks its submenu parent aria-haspopup ${hs}`,
    );
    // The hotspots must stay pointer-transparent, or they'd eat the mouse from
    // the component that owns tap-to-toggle / drag-to-scroll underneath.
    assert.equal(
      childRoleHotspots.treeHotspotOwnsPointer,
      false,
      `${browserCase.name} treeitem hotspot does not capture the pointer ${hs}`,
    );
    assert.equal(
      childRoleHotspots.menuHotspotOwnsPointer,
      false,
      `${browserCase.name} menuitem hotspot does not capture the pointer ${hs}`,
    );
    for (const [kind, drag, expectedText] of [
      ['list', markdownListDrag, '• Item A'],
      ['table', markdownTableDrag, 'Alpha'],
    ] as const) {
      assert.equal(
        drag.mouseDownContentId,
        drag.expectedContentId,
        `${browserCase.name} Markdown ${kind} projection owns mousedown`,
      );
      assert.equal(
        drag.text,
        expectedText,
        `${browserCase.name} Markdown ${kind} supports pointer selection`,
      );
    }
    assert.deepEqual(
      [emojiStart.anchorOffset, emojiEnd.anchorOffset],
      [0, emojiEnd.sourceLength],
      `${browserCase.name} transformed ZWJ emoji caret stays on grapheme boundaries ${JSON.stringify({ emojiStart, emojiEnd })}`,
    );
    assert.ok(
      rtlLeftEdge.anchorOffset >= 12 &&
        rtlLeftEdge.anchorOffset <= rtlLeftEdge.sourceLength &&
        rtlRightEdge.anchorOffset <= 1,
      `${browserCase.name} ordinary RTL blank-edge clicks preserve physical-to-logical caret mapping ${JSON.stringify({ rtlLeftEdge, rtlRightEdge })}`,
    );
    assert.ok(
      rotatedTextEarly.hitContentId === rotatedTextEarly.expectedContentId &&
        rotatedTextLate.hitContentId === rotatedTextLate.expectedContentId &&
        rotatedTextEarly.absoluteOffset >= rotatedTextEarly.expectedStart &&
        rotatedTextEarly.absoluteOffset <= rotatedTextEarly.expectedEnd &&
        rotatedTextLate.absoluteOffset >= rotatedTextLate.expectedStart &&
        rotatedTextLate.absoluteOffset <= rotatedTextLate.expectedEnd,
      `${browserCase.name} rotated ordinary Text keeps two-dimensional caret routing ${JSON.stringify({ rotatedTextEarly, rotatedTextLate })}`,
    );
    assert.ok(
      mirroredRichEarly.hitContentId === mirroredRichEarly.expectedContentId &&
        mirroredRichLate.hitContentId === mirroredRichLate.expectedContentId &&
        mirroredRichEarly.absoluteOffset >= mirroredRichEarly.expectedStart &&
        mirroredRichEarly.absoluteOffset <= mirroredRichEarly.expectedEnd &&
        mirroredRichLate.absoluteOffset >= mirroredRichLate.expectedStart &&
        mirroredRichLate.absoluteOffset <= mirroredRichLate.expectedEnd,
      `${browserCase.name} mirrored non-uniform RichText keeps two-dimensional caret routing ${JSON.stringify({ mirroredRichEarly, mirroredRichLate })}`,
    );
    assert.ok(
      flowProjectionEarly.hitContentId === flowProjectionEarly.expectedContentId &&
        flowProjectionLate.hitContentId === flowProjectionLate.expectedContentId &&
        flowProjectionEarly.absoluteOffset >= flowProjectionEarly.expectedStart &&
        flowProjectionEarly.absoluteOffset <= flowProjectionEarly.expectedEnd &&
        flowProjectionLate.absoluteOffset >= flowProjectionLate.expectedStart &&
        flowProjectionLate.absoluteOffset <= flowProjectionLate.expectedEnd,
      `${browserCase.name} line-less custom ContentProjection keeps grapheme caret routing ${JSON.stringify({ flowProjectionEarly, flowProjectionLate })}`,
    );
    assert.deepEqual(
      [
        lamAlefVisualStart.anchorOffset,
        lamAlefVisualMiddle.anchorOffset,
        lamAlefVisualEnd.anchorOffset,
      ],
      [2, 1, 0],
      `${browserCase.name} transformed RTL Lam-Alef exposes its legal source carets`,
    );
    assert.equal(
      doubleClickWord.text,
      'office',
      `${browserCase.name} double-click selects a word ${JSON.stringify(doubleClickWord)}`,
    );
    assert.equal(
      tripleClickLine.text,
      'بلا',
      `${browserCase.name} triple-click selects a CRLF line`,
    );
    assert.equal(
      shiftExtended.text,
      'office ffi\n你好',
      `${browserCase.name} Shift-click preserves and extends the source anchor`,
    );
    assert.equal(
      mixedBidiExtended.text,
      'abc مرحبا 123',
      `${browserCase.name} mixed-bidi pointer selection preserves logical source order`,
    );
    for (const [name, source] of Object.entries(expected)) {
      const info = result.selection[name as keyof typeof result.selection];
      assert.equal(info.text, source, `${browserCase.name} ${name} native selection source`);
      assert.equal(info.textContent, source, `${browserCase.name} ${name} DOM source`);
      assert.equal(info.elementChildrenOnly, true, `${browserCase.name} ${name} line children`);
      assert.equal(
        info.rowCount,
        info.lines.length,
        `${browserCase.name} ${name} visual row count ${JSON.stringify(info.rectangles)}`,
      );
      assert.deepEqual(
        info.unmappedRectangles,
        [],
        `${browserCase.name} ${name} Range fragments outside visual rows`,
      );
      assert.ok(
        info.direction.every((direction) =>
          name === 'code' ? direction === 'ltr' : direction === 'auto',
        ),
      );
    }
    const codeInfo = result.selection.code;
    assert.equal(
      codeInfo.rectangles.some(
        (item) =>
          Math.abs(item.x - codeInfo.root.x) <= 1 && Math.abs(item.y - codeInfo.root.y) <= 1,
      ),
      false,
      `${browserCase.name} CodeBlock must not emit a root-origin selection fragment`,
    );
    assert.deepEqual(result.markdownTexts, [
      '• Item A',
      '• Item B',
      '1. First',
      '2. Second',
      'Name',
      'Value',
      'Alpha',
      '1',
    ]);
    assert.deepEqual(result.tableTexts, ['Name', 'Value', 'Alpha', '1']);
    assert.ok(
      result.maxCodeOverlap <= 0.5,
      `${browserCase.name} CodeBlock ink overlap ${result.maxCodeOverlap}px ${JSON.stringify(result.codeOverlapDetails)}`,
    );
    for (const [index, line] of result.codeGrid.lines.entries()) {
      const localDomWidth = line.localWidth;
      const expectedWidth = line.expectedWidth;
      assert.ok(
        Math.abs(localDomWidth - expectedWidth) <= 1,
        `${browserCase.name} CodeBlock row ${index} DOM/grid width mismatch: ${localDomWidth}px versus ${expectedWidth}px`,
      );
      assert.ok(
        line.maxStartError <= 1,
        `${browserCase.name} CodeBlock row ${index} projected cell start drift ${line.maxStartError}px`,
      );
      assert.ok(
        line.maxWidthError <= 1,
        `${browserCase.name} CodeBlock row ${index} projected cell width drift ${line.maxWidthError}px ${JSON.stringify(line)}`,
      );
      // Consecutive selection rects must tile the grid pitch, or the untiled
      // remainder paints as a vertical unhighlighted line between glyphs. The
      // bound is a quarter of a CSS pixel: a browser rounds rects to 1/64 device
      // px, so some residue is unavoidable, but the defect this guards was
      // 0.133 px on a real page and any regression of the calibration basis
      // reappears at that scale or larger.
      assert.ok(
        line.maxSeamResidue <= 0.25,
        `${browserCase.name} CodeBlock row ${index} selection seam residue ${line.maxSeamResidue}px ${JSON.stringify(line.worstSeam)}`,
      );
    }
    // A projected hard break must not paint. Written as ordinary inline text in a
    // `white-space: pre` carrier, a `\n` gets a zero-width, full-line-height
    // selection rect that Chrome draws as a caret-like bar past the last glyph —
    // ink with no glyph under it. Measured on a live page before the fix: one
    // paragraph line produced such a rect at `x 495.18, w 0, h 31.82`, and a
    // CodeBlock fixture produced one on every row owning a break.
    assert.equal(
      result.breakSlivers.sliverCount,
      0,
      `${browserCase.name} projected hard breaks painted ${result.breakSlivers.sliverCount} zero-width selection rect(s) ${JSON.stringify(result.breakSlivers.worst)}`,
    );
    // The other half of the contract: the break is suppressed visually, never
    // deleted. Counting carriers rather than inspecting text, because a
    // SOFT-wrapped paragraph is legitimately many carrier lines with no `\n`
    // anywhere — an earlier spelling of this check flagged exactly that. The
    // clipboard assertion above is what proves the breaks still serialise.
    assert.ok(
      result.breakSlivers.breakCarriers > 0,
      `${browserCase.name} found no hard-break carriers, so the breaks were dropped rather than collapsed`,
    );
    assert.ok(
      result.breakSlivers.rootCount > 0,
      `${browserCase.name} break-sliver check found no content projections`,
    );
    assert.ok(
      result.ligature.disabledWidth - result.ligature.normalWidth >= 0.25,
      `${browserCase.name} ligature precondition was not met`,
    );
    assert.ok(
      Math.abs(result.ligature.domWidth - result.ligature.canvasWidth) <= 1,
      `${browserCase.name} ligature DOM/Canvas width mismatch`,
    );
    // RTL now renders glyph-by-glyph (so the engine can right-align + reorder),
    // so the canvas width is a sum of per-glyph advances while the DOM measures
    // the kerned whole string. That advance-vs-kerned gap is a few px on a 24px
    // mixed-bidi line, and widens under font substitution + fractional DPR/zoom
    // (the missing-CJK cases). It is a width-fidelity artifact, NOT a selection
    // misalignment — caret hit-mapping and per-glyph selection-rect overlap are
    // verified separately. Use a small relative tolerance so gross breaks still
    // fail but the advance/kerning/substitution delta passes across scales.
    const rtlTol = Math.max(4, result.rtlWidths.canvas * 0.06);
    assert.ok(
      Math.abs(result.rtlWidths.dom - result.rtlWidths.canvas) <= rtlTol,
      `${browserCase.name} RTL DOM/Canvas width mismatch ${JSON.stringify(result.rtlWidths)}`,
    );

    if (browserCase.forcedColors) {
      const styles = result.selection.code;
      assert.match(styles.color, /rgba\(0, 0, 0, 0\)|transparent/);
      assert.match(styles.textFill, /rgba\(0, 0, 0, 0\)|transparent/);
      assert.equal(styles.forcedColorAdjust, 'none');
      const pixels = await screenshotDiff(
        page,
        (await page.evaluate(() => (window as any).__vecto.code.id)) as string,
      );
      assert.ok(pixels.unselectedRatio <= 0.001, `${browserCase.name} projection leaked pixels`);
      assert.ok(pixels.maxChannelDelta <= 2, `${browserCase.name} projection leaked ink`);
      assert.ok(
        pixels.selectedPixels >= 50,
        `${browserCase.name} selection highlight was invisible`,
      );
    }

    await page.evaluate(async () => {
      const app = (window as any).__vecto;
      app.transformedCode.rotation = Math.PI;
      app.transformedCode.scaleX = 1;
      app.transformedCode.scaleY = 1;
      app.scene.markDirty();
      await new Promise<void>((done) =>
        requestAnimationFrame(() => requestAnimationFrame(() => done())),
      );
    });
    const halfTurnStart = await clickGridSource(page, 'transformedCode', '👩‍💻', 0.1);
    const halfTurnEnd = await clickGridSource(page, 'transformedCode', '👩‍💻', 0.9);
    await page.evaluate(async () => {
      const app = (window as any).__vecto;
      app.transformedCode.rotation = 0;
      app.transformedCode.scaleX = -1;
      app.scene.markDirty();
      await new Promise<void>((done) =>
        requestAnimationFrame(() => requestAnimationFrame(() => done())),
      );
    });
    const mirrorStart = await clickGridSource(page, 'transformedCode', '👩‍💻', 0.1);
    const mirrorEnd = await clickGridSource(page, 'transformedCode', '👩‍💻', 0.9);
    for (const [kind, start, end] of [
      ['half-turn', halfTurnStart, halfTurnEnd],
      ['mirror', mirrorStart, mirrorEnd],
    ] as const) {
      assert.deepEqual(
        [start.anchorOffset, end.anchorOffset],
        [0, end.sourceLength],
        `${browserCase.name} ${kind} grid hit-testing preserves local caret direction ${JSON.stringify({ start, end })}`,
      );
    }

    const hiddenGridBefore = await page.evaluate(() => {
      const app = (window as any).__vecto;
      const root = app.scene.getContentElement(app.largeCode.id) as HTMLElement;
      const snapshot = {
        display: root.style.display,
        carriers: Number(root.dataset.vectoGridCarriers),
        samples: Number(root.dataset.vectoGridCalibrationSamples),
        materializeMs: Number(root.dataset.vectoGridMaterializeMs),
        calibrationMs: Number(root.dataset.vectoGridCalibrationMs),
      };
      app.largeCode.setPosition(300, 1100);
      app.scene.markDirty();
      return snapshot;
    });
    await page.waitForFunction(() => {
      const app = (window as any).__vecto;
      return app.scene.getContentElement(app.largeCode.id)?.style.display !== 'none';
    });
    const hiddenGridAfter = await page.evaluate(() => {
      const app = (window as any).__vecto;
      const root = app.scene.getContentElement(app.largeCode.id) as HTMLElement;
      const cell = root.querySelector<HTMLElement>('[data-vecto-grid-cell]')!;
      const sourceLength = Number(cell.dataset.vectoGridSourceLength);
      const targetWidth = Number(cell.dataset.vectoGridAdvance);
      const range = document.createRange();
      range.setStart(cell.firstChild!, 0);
      range.setEnd(cell.firstChild!, sourceLength);
      const line = cell.parentElement!;
      const lineRect = line.getBoundingClientRect();
      const localWidth = Number.parseFloat(line.style.width);
      const scale = lineRect.width / localWidth;
      const rect = range.getBoundingClientRect();
      return {
        widthError: Math.abs(rect.width - targetWidth * scale),
        pendingProbe: document.querySelectorAll('[data-vecto-grid-probe]').length,
      };
    });
    assert.equal(hiddenGridBefore.display, 'none', `${browserCase.name} large grid starts hidden`);
    // 100 lines x 80 cells = 8000 carriers if every line is materialized, but the
    // per-line window (CTX-0195) keeps only the band near the viewport: this block
    // sits at y=1100 in a 1400-tall viewport whose projection margin is another
    // 1400, so roughly 71 of its 100 lines qualify. The subject of this case is
    // COLD calibration on a hidden grid, not the carrier count, so assert the
    // window is a bounded non-empty subset and that it is a whole number of
    // 80-cell lines — a partially materialized line would mean the window split
    // mid-line, which would corrupt selection geometry.
    assert.ok(
      hiddenGridBefore.carriers > 0 && hiddenGridBefore.carriers <= 8000,
      `${browserCase.name} large grid carrier count ${hiddenGridBefore.carriers} outside (0, 8000]`,
    );
    assert.equal(
      hiddenGridBefore.carriers % 80,
      0,
      `${browserCase.name} large grid window split a line: ${hiddenGridBefore.carriers} carriers is not a multiple of 80`,
    );
    assert.ok(
      hiddenGridBefore.samples > 0 && hiddenGridBefore.samples <= 64,
      `${browserCase.name} cold calibration did not deduplicate samples ${JSON.stringify(hiddenGridBefore)}`,
    );
    assert.ok(
      Number.isFinite(hiddenGridBefore.materializeMs) &&
        Number.isFinite(hiddenGridBefore.calibrationMs),
      `${browserCase.name} cold calibration timings are unavailable`,
    );
    assert.ok(
      hiddenGridAfter.widthError <= 1,
      `${browserCase.name} hidden grid calibration drifted after reveal`,
    );
    assert.equal(hiddenGridAfter.pendingProbe, 0, `${browserCase.name} hidden grid leaked a probe`);

    // ── Long lines must stay inside the block box ────────────────────────────
    //
    // A code line does not wrap: cells are placed at `col × cellWidth`, so a
    // line longer than the box used to paint straight through the rounded
    // background and off the viewport edge, where no scroll and no wrap could
    // bring the tail back. The reading is `cell right edge − block box right
    // edge` in CLIENT px, taken with the block moved into view.
    //
    // Every earlier attempt at this figure reported `boxWidth: 0` /
    // `cellCount: 0`, which is not a zero-width block — it is a block that had
    // scrolled out of the carrier window, so nothing was measured at all. Hence
    // the block is moved on-screen and awaited first, and a missing reading
    // throws below instead of being reported as `0`.
    await page.evaluate(() => {
      const app = (window as any).__vecto;
      app.overflowCode.setPosition(40, 200);
      app.scene.markDirty();
    });
    await page.waitForFunction(() => {
      const app = (window as any).__vecto;
      const root = app.scene.getContentElement(app.overflowCode.id) as HTMLElement | null;
      return (
        !!root &&
        root.style.display !== 'none' &&
        root.dataset.vectoGridReady === 'true' &&
        root.querySelectorAll('[data-vecto-grid-cell]').length > 0
      );
    });
    const overflow = await page.evaluate(() => {
      const app = (window as any).__vecto;
      const root = app.scene.getContentElement(app.overflowCode.id) as HTMLElement;
      const rootRect = root.getBoundingClientRect();
      const cells = [...root.querySelectorAll<HTMLElement>('[data-vecto-grid-cell]')];
      // What the CANVAS drew, in entity-local px. The DOM carriers are
      // deliberately NOT clipped to the block (the a11yRoot clips at the viewport
      // so find-in-page can still reach text, and selection must be able to start
      // in blank regions), so a carrier rect cannot answer "did a glyph paint
      // outside the background". Only the draw trace can.
      const block = app.overflowCode;
      const trace = ((window as any).__vectoFillTrace ?? []) as Array<{
        text: string;
        x: number;
        y: number;
        width: number;
        a: number;
        b: number;
        c: number;
        d: number;
        e: number;
        f: number;
      }>;
      // Trace x/y are entity-LOCAL (the draw walk translates by `node.x/node.y`
      // before calling `render()`), so local coordinates alone cannot separate two
      // blocks whose local boxes overlap — which they all do, every block having a
      // local origin of 0,0. Attribute a draw by its TRANSLATION instead, which is
      // this block's world position times the canvas scale.
      const world = block.getWorldTransform();
      const drawn = trace.filter(
        (entry) =>
          // No rotated/skewed entity.
          Math.abs(entry.b) <= 0.001 &&
          Math.abs(entry.c) <= 0.001 &&
          entry.text.trim().length > 0 &&
          // This block's own draws: the translation carries its world x/y, scaled
          // by the same device-pixel-ratio scale the canvas is set up with.
          Math.abs(entry.e - world.e * entry.a) <= 0.5 &&
          Math.abs(entry.f - world.f * entry.d) <= 0.5,
      );
      const rights = drawn.map((entry) => entry.x + entry.width);
      return {
        cellCount: cells.length,
        boxWidth: rootRect.width,
        blockWidth: block.width,
        drawnCount: drawn.length,
        // Widest submitted draw extent past the block's own background box, local
        // px. A cell whose origin is inside the box but whose advance crosses the
        // edge is SUBMITTED whole and clipped by the renderer, so a correct
        // implementation still reads up to one cell width here — see the assertion.
        overflowPx: rights.length > 0 ? Math.max(...rights) - block.width : Number.NaN,
        cellWidth: block.getContentProjection()?.grid?.cellWidth ?? Number.NaN,
        scrollX: block.scrollX ?? 0,
        maxScrollX: block.maxScrollX ?? 0,
      };
    });
    // Guard, not an assertion about the fix: without a real reading the
    // overflow assertion below would pass vacuously on a `0`.
    if (!(overflow.cellCount > 0 && overflow.boxWidth > 0 && overflow.drawnCount > 0)) {
      throw new Error(
        `${browserCase.name} overflow probe measured NOTHING (cellCount=${overflow.cellCount}, boxWidth=${overflow.boxWidth}, drawnCount=${overflow.drawnCount}) — the block was outside the carrier window or no draw was attributed to it, so this is not a zero-width reading`,
      );
    }
    assert.ok(
      Number.isFinite(overflow.overflowPx),
      `${browserCase.name} overflow probe produced no finite reading ${JSON.stringify(overflow)}`,
    );
    // The trace records draws SUBMITTED to the canvas, which the renderer's clip
    // then bounds — it cannot observe the clip itself. So the budget is one cell
    // plus a px of rounding: the cell straddling the right edge is submitted whole
    // and clipped, while a cell entirely outside is skipped before submission.
    //
    // What this catches is the defect and any regression of it: unclipped, the same
    // reading was 1016.984px, i.e. ~68 cells past the edge rather than part of one.
    // Whether the clipped glyphs actually stop at the background is a question only
    // pixels can answer, and is verified by screenshot in both engines.
    const overflowBudget = (Number.isFinite(overflow.cellWidth) ? overflow.cellWidth : 0) + 1;
    assert.ok(
      overflow.overflowPx <= overflowBudget,
      `${browserCase.name} code cells reach ${overflow.overflowPx.toFixed(3)}px past the block box, over a ${overflowBudget.toFixed(3)}px budget (one cell + rounding) — a long line's tail is painting outside the background ${JSON.stringify(overflow)}`,
    );
    // Not painting outside the box is only half the fix: a block that clipped the
    // tail away without offering any scroll would satisfy the assertion above and
    // still leave the tail unreachable, which is the defect.
    assert.ok(
      overflow.maxScrollX > 0,
      `${browserCase.name} a line ${overflow.blockWidth}px-wide block cannot scroll (maxScrollX ${overflow.maxScrollX}) so the tail is still unreachable`,
    );
    // And the tail must actually come into view when scrolled to the end.
    const scrolledTail = await page.evaluate(() => {
      const app = (window as any).__vecto;
      const block = app.overflowCode;
      block.setScrollX(block.maxScrollX);
      app.scene.markDirty();
      return { scrollX: block.scrollX, maxScrollX: block.maxScrollX };
    });
    // Wait for the CARRIERS to follow, not for `vectoGridReady` — that flag was
    // already `true` before the scroll, so waiting on it reads pre-rebuild DOM and
    // makes this probe a race (it passed at DPR 1 and failed under zoom purely on
    // timing). The line's own `left` is the thing that must change.
    await page.waitForFunction(() => {
      const app = (window as any).__vecto;
      const root = app.scene.getContentElement(app.overflowCode.id) as HTMLElement | null;
      const line = root?.querySelector<HTMLElement>('[data-vecto-grid-line="0"]');
      if (!line || root?.dataset.vectoGridReady !== 'true') return false;
      const left = Number.parseFloat(line.style.left || '0');
      // Scrolled to the end, so the first line's origin is far negative.
      return Number.isFinite(left) && left < 0;
    });
    const tailReach = await page.evaluate(() => {
      const app = (window as any).__vecto;
      const block = app.overflowCode;
      const root = app.scene.getContentElement(block.id) as HTMLElement;
      const rootRect = root.getBoundingClientRect();
      const cells = [...root.querySelectorAll<HTMLElement>('[data-vecto-grid-cell]')];
      // The LAST cell of the long first line: its carrier must now overlap the
      // block box, which is what "the tail is reachable" means for selection.
      const line = root.querySelector<HTMLElement>('[data-vecto-grid-line="0"]')!;
      const lineCells = [...line.querySelectorAll<HTMLElement>('[data-vecto-grid-cell]')];
      const last = lineCells[lineCells.length - 1]!.getBoundingClientRect();
      return {
        cellCount: cells.length,
        lineCellCount: lineCells.length,
        // Positive when the final glyph's carrier sits inside the block box.
        tailInsideBy: rootRect.right - last.left,
        boxWidth: rootRect.width,
      };
    });
    if (!(tailReach.lineCellCount > 0 && tailReach.boxWidth > 0)) {
      throw new Error(
        `${browserCase.name} tail-reach probe measured NOTHING ${JSON.stringify(tailReach)}`,
      );
    }
    assert.ok(
      tailReach.tailInsideBy > 0,
      `${browserCase.name} scrolled to the end (${scrolledTail.scrollX.toFixed(1)}/${scrolledTail.maxScrollX.toFixed(1)}px) and the last glyph of the line is still outside the block box ${JSON.stringify(tailReach)}`,
    );
    // Restore, so later cases see an unscrolled block.
    await page.evaluate(() => {
      const app = (window as any).__vecto;
      app.overflowCode.setScrollX(0);
      app.scene.markDirty();
    });

    pageErrors.length = 0;
    const rebuildStart = await page.evaluate(() => {
      const app = (window as any).__vecto;
      const root = app.scene.getContentElement(app.code.id) as HTMLElement;
      const first = root.children[0].getBoundingClientRect();
      return {
        x: root.getBoundingClientRect().left + 4,
        y: first.top + first.height / 2,
      };
    });
    await page.mouse.move(rebuildStart.x, rebuildStart.y);
    await page.mouse.down();
    await page.evaluate(() => {
      const app = (window as any).__vecto;
      app.code.setCode('changed\ncontent');
      app.scene.markDirty();
    });
    await page.waitForFunction(() => {
      const app = (window as any).__vecto;
      const root = app.scene.getContentElement(app.code.id) as HTMLElement;
      return root.textContent === 'changed\ncontent' && root.dataset.vectoGridReady === 'true';
    });
    await page.mouse.up();
    const rebuildLifecycle = await page.evaluate(() => {
      const app = (window as any).__vecto;
      const root = app.scene.getContentElement(app.code.id) as HTMLElement;
      return {
        rootPointerEvents: root.parentElement?.style.pointerEvents ?? '',
        pendingFrames: app.scene.contentGridCalibrationFrames.size,
        pendingProbes: document.querySelectorAll('[data-vecto-grid-probe]').length,
        pendingCalibration: root.dataset.vectoGridCalibrationPending ?? null,
      };
    });
    assert.deepEqual(
      rebuildLifecycle,
      {
        rootPointerEvents: 'none',
        pendingFrames: 0,
        pendingProbes: 0,
        pendingCalibration: null,
      },
      `${browserCase.name} projection rebuild releases selection and calibration ownership`,
    );
    assert.deepEqual(pageErrors, [], `${browserCase.name} emitted browser errors during rebuild`);

    const worstSeamResidue = Math.max(
      0,
      ...result.codeGrid.lines.map((line) => line.maxSeamResidue),
    );
    console.log(
      `✓ ${browserCase.name}: selection and cold grid (${hiddenGridBefore.materializeMs.toFixed(1)}ms materialize, ${hiddenGridBefore.calibrationMs.toFixed(1)}ms calibrate, ${hiddenGridBefore.samples} samples, ${worstSeamResidue.toFixed(4)}px worst seam)`,
    );
  } finally {
    await browser.close();
  }
}

async function main(): Promise<void> {
  const fixture = await build({
    entryPoints: [join(packageRoot, 'e2e/text-projection.fixture.ts')],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    write: false,
    logLevel: 'silent',
  });
  const fixtureSource = fixture.outputFiles[0]?.text;
  if (!fixtureSource) throw new Error('Failed to bundle the text projection browser fixture');

  const server = createServer((request, response) => {
    const pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
    if (pathname === '/' || pathname === '/index.html') {
      response.setHeader('content-type', 'text/html');
      response.end(pageMarkup);
      return;
    }
    if (pathname === '/fixture.mjs') {
      response.setHeader('content-type', 'text/javascript');
      response.end(fixtureSource);
      return;
    }
    response.statusCode = 404;
    response.end('not found');
  });
  await new Promise<void>((done) => server.listen(0, done));
  const port = (server.address() as { port: number }).port;
  const url = `http://127.0.0.1:${port}/`;

  const chromium = executable(
    [process.env.PUPPETEER_EXECUTABLE_PATH ?? '', '/usr/bin/chromium', '/usr/bin/google-chrome'],
    'Chromium',
  );
  const firefox = executable(
    [process.env.FIREFOX_EXECUTABLE_PATH ?? '', '/usr/bin/firefox'],
    'Firefox',
  );
  const notoPrefs = {
    'browser.display.use_document_fonts': 0,
    'font.name.serif.x-western': 'Noto Serif',
    'font.name.sans-serif.x-western': 'Noto Serif',
    'font.name.monospace.x-western': 'Noto Serif',
  };
  const cases: BrowserCase[] = [
    {
      name: 'chromium-dpr1',
      browser: 'chrome',
      executablePath: chromium,
      dpr: 1,
    },
    {
      name: 'chromium-dpr1.5-zoom90',
      browser: 'chrome',
      executablePath: chromium,
      dpr: 1.5,
      zoom: 0.9,
    },
    {
      name: 'firefox-dpr1',
      browser: 'firefox',
      executablePath: firefox,
      dpr: 1,
    },
    {
      name: 'firefox-dpr1.5',
      browser: 'firefox',
      executablePath: firefox,
      dpr: 1.5,
    },
    {
      name: 'firefox-dpr1.5-zoom90',
      browser: 'firefox',
      executablePath: firefox,
      dpr: 1.5,
      zoom: 0.9,
    },
    {
      name: 'firefox-missing-cjk-dpr1.5-zoom90',
      browser: 'firefox',
      executablePath: firefox,
      dpr: 1.5,
      zoom: 0.9,
      extraPrefsFirefox: {
        'font.system.whitelist': 'DejaVu Sans,Noto Color Emoji',
        'font.name.monospace.x-western': 'DejaVu Sans',
      },
    },
    {
      name: 'firefox-noto-serif',
      browser: 'firefox',
      executablePath: firefox,
      dpr: 1,
      extraPrefsFirefox: notoPrefs,
    },
    {
      name: 'firefox-noto-serif-forced-colors',
      browser: 'firefox',
      executablePath: firefox,
      dpr: 1,
      forcedColors: true,
      extraPrefsFirefox: {
        ...notoPrefs,
        'browser.display.document_color_use': 2,
        'browser.display.use_system_colors': true,
      },
    },
  ];

  try {
    for (const browserCase of cases) await verifyCase(browserCase, url);
  } finally {
    server.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
