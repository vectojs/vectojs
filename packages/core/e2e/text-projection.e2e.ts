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
      trace.push({
        text: String(text),
        x,
        y,
        font: this.font,
        width: metrics.width,
        left: metrics.actualBoundingBoxLeft,
        right: metrics.actualBoundingBoxRight,
      });
      return maxWidth === undefined
        ? original.call(this, text, x, y)
        : original.call(this, text, x, y, maxWidth);
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
      }>;
      const codeTrace = [
        ...new Map(
          trace
            .filter((entry) => entry.font.startsWith('15px') && entry.y >= 30 && entry.y <= 80)
            .map((entry) => [
              `${entry.text}\u0000${entry.x}\u0000${entry.y}\u0000${entry.font}`,
              entry,
            ]),
        ).values(),
      ].sort((a, b) => a.y - b.y || a.x - b.x);
      const overlaps: number[] = [];
      for (let index = 1; index < codeTrace.length; index++) {
        const previous = codeTrace[index - 1];
        const current = codeTrace[index];
        if (current.y !== previous.y) continue;
        const previousEnd = previous.x + previous.right;
        const currentStart = current.x - current.left;
        overlaps.push(Math.max(0, previousEnd - currentStart));
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
        ...[...rtlProjection.children].map((line) => line.getBoundingClientRect().width),
      );

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
          domWidth: (
            app.scene.getContentElement(app.ligature.id) as HTMLElement
          ).children[0].getBoundingClientRect().width,
          canvasWidth: ligatureTrace?.width ?? 0,
        },
        rtlWidths: { dom: rtlDomWidth, canvas: rtlCanvasWidth },
        maxCodeOverlap: Math.max(0, ...overlaps),
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

    for (const [name, values] of Object.entries(result.baselines)) {
      assert.ok(
        Math.abs(values.actual - values.expected) <= 1,
        `${browserCase.name} ${name} baseline expected ${values.expected}, got ${values.actual}`,
      );
    }
    assert.match(result.textarea.font, /16px/);
    assert.match(result.textarea.lineHeight, /22\.4px|20\.16px/);
    assert.match(result.textarea.padding, /10px|9px/);
    assert.equal(result.textarea.boxSizing, 'border-box');

    const expected = {
      text: 'alpha beta gamma delta epsilon zeta eta theta',
      code: 'const value = 42;\nconsole.log(value);',
      rich: 'small office مرحبا VectoJS',
      rtl: 'مرحبا بك في VectoJS',
      ligature: 'office affinity ffi',
    };
    assert.equal(
      pastedCode,
      expected.code,
      `${browserCase.name} real keyboard copy/paste preserves CodeBlock source`,
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
      assert.ok(info.direction.every((direction) => direction === 'auto'));
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
      `${browserCase.name} CodeBlock ink overlap ${result.maxCodeOverlap}px`,
    );
    assert.ok(
      result.ligature.disabledWidth - result.ligature.normalWidth >= 0.25,
      `${browserCase.name} ligature precondition was not met`,
    );
    assert.ok(
      Math.abs(result.ligature.domWidth / (browserCase.zoom ?? 1) - result.ligature.canvasWidth) <=
        1,
      `${browserCase.name} ligature DOM/Canvas width mismatch`,
    );
    assert.ok(
      Math.abs(result.rtlWidths.dom / (browserCase.zoom ?? 1) - result.rtlWidths.canvas) <= 2,
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

    console.log(
      `✓ ${browserCase.name}: selection, source order, typography, and component propagation`,
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
