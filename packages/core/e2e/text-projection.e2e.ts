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
      });
      return maxWidth === undefined
        ? original.call(this, text, x, y)
        : original.call(this, text, x, y, maxWidth);
    };
    const rangeGeometryReads = { bounding: 0, clientRects: 0 };
    Object.defineProperty(window, '__vectoRangeGeometryReads', { value: rangeGeometryReads });
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
): Promise<{ unselectedRatio: number; maxChannelDelta: number; selectedPixels: number }> {
  const clip = await page.evaluate((id) => {
    const app = (window as any).__vecto;
    const element = app.scene.getContentElement(id) as HTMLElement;
    const bounds = element.getBoundingClientRect();
    (document.getElementById('canvas') as HTMLElement).style.visibility = 'hidden';
    getSelection()?.removeAllRanges();
    return { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height };
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

async function dragMarkdownProjection(
  page: Page,
  projectedText: string,
): Promise<{ text: string; expectedContentId: string; mouseDownContentId: string | null }> {
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
    defaultViewport: { width: 1200, height: 1400, deviceScaleFactor: browserCase.dpr },
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
      await page.evaluate((zoom) => {
        document.body.style.zoom = String(zoom);
      }, browserCase.zoom);
      await page.evaluate(
        () => new Promise((done) => requestAnimationFrame(() => done(undefined))),
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
          (entry.text.includes('VectoJS') || /[\uFE70-\uFEFF]/u.test(entry.text)),
      );
      const rtlCanvasWidth = Math.max(0, ...rtlTrace.map((entry) => entry.width));
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
              startError: Math.abs(
                rect.left - (lineRect.left + Number(cell.dataset.vectoGridX) * scale),
              ),
              widthError: Math.abs(rect.width - target * scale),
            };
          },
        );
        return {
          domWidth: lineRect.width,
          localWidth,
          cells: [10, 4, 4, 5][index],
          maxStartError: Math.max(0, ...cells.map((cell) => cell.startError)),
          maxWidthError: Math.max(0, ...cells.map((cell) => cell.widthError)),
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

      return {
        baselines: {
          text: { actual: projected(app.text, 0), expected: expectedBaseline(app.text, 0) },
          code: { actual: projected(app.code, 1), expected: expectedBaseline(app.code, 1) },
          rich: { actual: projected(app.rich, 0), expected: expectedBaseline(app.rich, 0) },
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
        forward: { anchor: 'o', anchorOffset: 0, focus: '好\n', focusOffset: 1 },
        reverse: { anchor: '好\n', anchorOffset: 1, focus: 'o', focusOffset: 0 },
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
      const expectedWidth = line.cells * result.codeGrid.cellWidth;
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
        `${browserCase.name} CodeBlock row ${index} projected cell width drift ${line.maxWidthError}px`,
      );
    }
    assert.ok(
      result.ligature.disabledWidth - result.ligature.normalWidth >= 0.25,
      `${browserCase.name} ligature precondition was not met`,
    );
    assert.ok(
      Math.abs(result.ligature.domWidth - result.ligature.canvasWidth) <= 1,
      `${browserCase.name} ligature DOM/Canvas width mismatch`,
    );
    assert.ok(
      Math.abs(result.rtlWidths.dom - result.rtlWidths.canvas) <= 2,
      `${browserCase.name} RTL DOM/Canvas width mismatch`,
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
    assert.equal(hiddenGridBefore.carriers, 8000, `${browserCase.name} large grid carrier count`);
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

    pageErrors.length = 0;
    const rebuildStart = await page.evaluate(() => {
      const app = (window as any).__vecto;
      const root = app.scene.getContentElement(app.code.id) as HTMLElement;
      const first = root.children[0].getBoundingClientRect();
      return { x: root.getBoundingClientRect().left + 4, y: first.top + first.height / 2 };
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

    console.log(
      `✓ ${browserCase.name}: selection and cold grid (${hiddenGridBefore.materializeMs.toFixed(1)}ms materialize, ${hiddenGridBefore.calibrationMs.toFixed(1)}ms calibrate, ${hiddenGridBefore.samples} samples)`,
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
    { name: 'chromium-dpr1', browser: 'chrome', executablePath: chromium, dpr: 1 },
    {
      name: 'chromium-dpr1.5-zoom90',
      browser: 'chrome',
      executablePath: chromium,
      dpr: 1.5,
      zoom: 0.9,
    },
    { name: 'firefox-dpr1', browser: 'firefox', executablePath: firefox, dpr: 1 },
    { name: 'firefox-dpr1.5', browser: 'firefox', executablePath: firefox, dpr: 1.5 },
    {
      name: 'firefox-dpr1.5-zoom90',
      browser: 'firefox',
      executablePath: firefox,
      dpr: 1.5,
      zoom: 0.9,
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
