// Executes every code sample and factual claim the reference docs make, so a
// page cannot drift from the API it documents. Each describe block maps to one
// doc section; the block name is the page.
//
// Vitest aliases @vectojs/* to the sibling `src/`, so these run against working
// source rather than the last publish — a doc claim breaks here before it can
// reach a reader. Current at core 1.25.0, ui 2.6.0, devtools 0.11.0,
// markdown 0.6.0.
import { describe, it, expect } from 'vitest';
import { Scene, Entity, Circle, Rect } from '@vectojs/core';
import { Text, ScrollView, Card } from '@vectojs/ui';
import { Markdown } from '@vectojs/markdown';
import {
  auditA11y,
  auditAccelerators,
  auditGpu,
  auditScene,
  captureSnapshot,
  clearDevtoolsPlugins,
  createDevtoolsBackend,
  createDevtoolsClient,
  createDirectTransportPair,
  DEVTOOLS_CHANNEL,
  DEVTOOLS_PROTOCOL_VERSION,
  diagnoseDirty,
  diffSnapshots,
  entityPath,
  explainHitTest,
  formatHitExplanation,
  highlightGeometry,
  inspectAccelerators,
  inspectEntity,
  inspectMarkdownStream,
  isMarkdownEntity,
  pickInScene,
  registerDevtoolsPlugin,
  runPluginAudits,
  runPluginCommand,
  runPluginInspector,
  sampleHitRegion,
} from '@vectojs/devtools/headless';
import type { IRenderer } from '@vectojs/core';

function makeScene(): Scene {
  const canvas = document.createElement('canvas');
  document.body.appendChild(canvas);
  return new Scene(canvas);
}

const isDirty = (scene: Scene) => (scene as unknown as { dirty: boolean }).dirty;
const clearDirty = (scene: Scene) => {
  (scene as unknown as { dirty: boolean }).dirty = false;
};

/** Simple sized box for audit/snapshot samples. */
class Box extends Entity {
  constructor(w: number, h: number) {
    super();
    this.width = w;
    this.height = h;
  }
  isPointInside(gx: number, gy: number): boolean {
    const local = this.worldToLocal(gx, gy);
    if (!local) return false;
    return local.x >= 0 && local.x <= this.width && local.y >= 0 && local.y <= this.height;
  }
  getBounds() {
    return { x: 0, y: 0, width: this.width, height: this.height };
  }
  render(_r: IRenderer): void {}
}

describe('streaming doc: per-frame chunk coalescing', () => {
  it('coalesces N tokens into one append per animation frame', () => {
    // The doc sample: buffer tokens, flush once per rAF.
    const flushes: string[] = [];
    const target = {
      appendMarkdown(chunk: string) {
        flushes.push(chunk);
      },
    };

    let raf: FrameRequestCallback | null = null;
    const requestFrame = (cb: FrameRequestCallback) => {
      raf = cb;
      return 1;
    };

    // --- sample begins (as documented) ---
    let pending = '';
    let scheduled = false;
    function pushToken(token: string) {
      pending += token;
      if (scheduled) return;
      scheduled = true;
      requestFrame(() => {
        scheduled = false;
        const chunk = pending;
        pending = '';
        target.appendMarkdown(chunk);
      });
    }
    // --- sample ends ---

    for (const t of ['Hello', ' ', 'world', '!']) pushToken(t);
    expect(flushes).toEqual([]); // nothing flushed mid-frame
    raf!(0);
    expect(flushes).toEqual(['Hello world!']); // one layout for four tokens

    pushToken(' More');
    raf!(16);
    expect(flushes).toEqual(['Hello world!', ' More']);
  });
});

describe('streaming doc: Markdown.appendMarkdown reuses prefix entities', () => {
  it('appends without rebuilding finished paragraphs', () => {
    const scene = makeScene();
    const md = new Markdown('# Title\n\nFirst paragraph.\n\n', {
      maxWidth: 400,
    });
    scene.add(md);

    const content = (md as unknown as { content: Entity }).content;
    const before = [...content.children];
    expect(before.length).toBeGreaterThanOrEqual(2); // heading + paragraph

    md.appendMarkdown('Second paragraph grows');
    md.appendMarkdown(' token by token.');

    const after = [...content.children];
    // Finished prefix entities are the same object instances (reused).
    expect(after[0]).toBe(before[0]);
    expect(after[1]).toBe(before[1]);
    expect(after.length).toBe(before.length + 1); // one new paragraph appended
  });

  it('setContent rebuilds everything (the anti-pattern)', () => {
    const scene = makeScene();
    const md = new Markdown('# Title\n\nBody.', { maxWidth: 400 });
    scene.add(md);
    const content = (md as unknown as { content: Entity }).content;
    const before = [...content.children];

    md.setContent('# Title\n\nBody. More.');
    const after = [...content.children];
    expect(after[0]).not.toBe(before[0]); // full rebuild — nothing reused
  });
});

describe('streaming doc: Text.append is the cold path with paragraph memo', () => {
  it('append() extends text and marks the scene dirty', () => {
    const scene = makeScene();
    const label = new Text('Line one\n', {
      font: '16px sans-serif',
      maxWidth: 300,
    });
    scene.add(label);
    clearDirty(scene);

    label.append('and line two');
    expect(label.text).toBe('Line one\nand line two');
    expect(isDirty(scene)).toBe(true);
  });

  it('setMaxWidth() reflows without changing content', () => {
    const scene = makeScene();
    const label = new Text('word '.repeat(40), {
      font: '16px sans-serif',
      maxWidth: 320,
    });
    scene.add(label);
    const tallBefore = label.height;
    label.setMaxWidth(160);
    expect(label.height).toBeGreaterThan(tallBefore); // narrower → more lines
    expect(label.text).toBe('word '.repeat(40));
  });
});

describe('streaming doc: ScrollView bottom-follow', () => {
  it('scrollToBottom targets the content end', () => {
    const scene = makeScene();
    const sv = new ScrollView({ width: 200, height: 100 });
    const content = new Box(200, 1000);
    sv.add(content);
    scene.add(sv);

    sv.scrollToBottom();
    // ScrollView stores the offset as a negative content translation:
    // -(content height - viewport height) when scrolled to the bottom.
    // scrollToBottom SNAPS (no spring), so content.y lands immediately.
    expect(sv.content.y).toBe(-900); // 1000px content - 100px viewport
  });

  it('the documented nearBottom() stickiness check works via public API', () => {
    // --- sample begins (as documented) ---
    function nearBottom(sv: ScrollView, slack = 24): boolean {
      const maxScroll = Math.max(0, sv.content.height - sv.height);
      return -sv.content.y >= maxScroll - slack;
    }
    // --- sample ends ---

    const scene = makeScene();
    const sv = new ScrollView({ width: 200, height: 100 });
    sv.add(new Box(200, 1000));
    scene.add(sv);

    expect(nearBottom(sv)).toBe(false); // at top of 1000px content
    sv.scrollToBottom(); // snaps — readable immediately
    expect(nearBottom(sv)).toBe(true);

    // scrollTo() SPRINGS: content.y animates toward the target over frames,
    // so settle the transition before reading position-derived state.
    sv.scrollTo(400);
    let t = 0;
    for (let i = 0; i < 600 && sv.content.hasPendingAnimations(); i++) {
      sv.content.update(16, (t += 16));
    }
    expect(nearBottom(sv)).toBe(false);
  });
});

describe('devtools doc: audit, snapshot/diff, inspect, pick', () => {
  it('auditScene flags sibling overlap and is clean for a sane layout', () => {
    const scene = makeScene();
    const a = new Box(100, 40);
    const b = new Box(100, 40);
    a.setPosition(0, 0);
    b.setPosition(0, 20); // overlaps a
    scene.add(a);
    scene.add(b);

    const findings = auditScene(scene);
    expect(findings.some((f) => f.kind === 'overlap')).toBe(true);

    b.setPosition(0, 60); // fix the overlap
    expect(auditScene(scene).filter((f) => f.kind === 'overlap')).toEqual([]);
  });

  it('captureSnapshot + diffSnapshots pinpoint what moved', () => {
    const scene = makeScene();
    const box = new Box(50, 50);
    scene.add(box);

    const before = captureSnapshot(scene);
    box.setPosition(10, 0);
    const diffs = diffSnapshots(before, captureSnapshot(scene));

    expect(diffs.length).toBeGreaterThan(0);
    const changed = diffs.find((d) => d.kind === 'changed');
    expect(changed).toBeDefined();
    expect(JSON.stringify(changed)).toContain('"x"');
  });

  it('pickInScene + inspectEntity answer "which entity owns this pixel"', () => {
    const scene = makeScene();
    const box = new Box(80, 30);
    box.setPosition(20, 20);
    box.interactive = true;
    scene.add(box);

    const hit = pickInScene(scene, 40, 30);
    expect(hit).toBe(box);
    const info = inspectEntity(hit!);
    expect(JSON.parse(JSON.stringify(info))).toBeTruthy(); // JSON-safe
    // Ancestry chain: "Scene > Box#<first-8-of-id>" (unlike snapshot-diff
    // paths, which use type[index] chains).
    expect(entityPath(hit!)).toMatch(/^Scene > Box#.{1,8}$/);
  });
});

describe('cross-environment doc: scene.resize recalibration hook', () => {
  it('scene.resize(w, h) updates logical size and marks dirty', () => {
    const scene = makeScene();
    scene.resize(800, 600);
    expect(scene.width).toBe(800);
    expect(scene.height).toBe(600);
  });
});

describe('streaming doc: markDirty coalescing under onDemand', () => {
  it('multiple appends in one frame leave a single dirty flag (natural coalescing)', () => {
    const scene = makeScene();
    scene.renderMode = 'onDemand';
    const label = new Text('start', { font: '16px sans-serif', maxWidth: 300 });
    scene.add(label);
    clearDirty(scene);

    label.append(' a');
    label.append(' b');
    label.append(' c');
    expect(isDirty(scene)).toBe(true); // one repaint will cover all three
  });
});

describe('core-entity doc: animateTo / springTo / setTransition', () => {
  it('animateTo tweens a property and resolves when done', () => {
    const scene = makeScene();
    const circle = new Circle({ radius: 20, fill: '#6366f1' });
    scene.add(circle);
    circle.setTransition({ x: { duration: 50, easing: 'easeOutQuad' } });
    circle.x = 200;
    for (let i = 0; i < 5; i++) scene.step(16.67);
    expect(circle.x).toBeGreaterThan(0);
    expect(circle.x).toBeLessThanOrEqual(200);
  });

  it('springTo resolves when motion settles', async () => {
    const scene = makeScene();
    const box = new Rect({ width: 60, height: 60, fill: '#ef4444' });
    scene.add(box);
    const promise = box.springTo({ x: 300, y: 200 });
    // advance past the spring settling
    for (let i = 0; i < 120; i++) scene.step(16.67);
    await promise;
    expect(box.x).toBe(300);
    expect(box.y).toBe(200);
  });

  it('setTransition auto-animates on assignment', () => {
    const scene = makeScene();
    const box = new Rect({ width: 80, height: 80, fill: '#10b981' });
    scene.add(box);
    box.setTransition({ opacity: { duration: 100, easing: 'easeOutQuad' } });
    box.opacity = 0.3;
    scene.step(16.67);
    expect(box.opacity).toBeGreaterThan(0.3);
    expect(box.opacity).toBeLessThan(1);
    for (let i = 0; i < 10; i++) scene.step(16.67);
    expect(box.opacity).toBe(0.3);
  });
});

describe('core-renderer doc: getContentProjection', () => {
  it('custom entity with content projection returns correct text', () => {
    const scene = makeScene();
    class Label extends Entity {
      text = 'canvas text';
      isPointInside() {
        return false;
      }
      render() {}
      getContentProjection() {
        return { text: this.text, font: '16px sans-serif', selectable: true };
      }
    }
    const label = new Label();
    scene.add(label);
    const proj = label.getContentProjection();
    expect(proj).toEqual({
      text: 'canvas text',
      font: '16px sans-serif',
      selectable: true,
    });
  });

  it('content projection with explicit visual rows', () => {
    const scene = makeScene();
    class MultilineLabel extends Entity {
      isPointInside() {
        return false;
      }
      render() {}
      getContentProjection() {
        return {
          text: 'line1\nline2',
          selectable: true,
          lines: [
            {
              text: 'line1',
              x: 0,
              y: 0,
              baseline: 16,
              font: '16px sans-serif',
              lineHeight: 20,
            },
            {
              text: 'line2',
              x: 0,
              y: 20,
              baseline: 36,
              font: '16px sans-serif',
              lineHeight: 20,
            },
          ],
        };
      }
    }
    const label = new MultilineLabel();
    scene.add(label);
    const proj = label.getContentProjection();
    expect(proj!.lines).toHaveLength(2);
    expect(proj!.lines![0].text).toBe('line1');
    expect(proj!.lines![1].text).toBe('line2');
  });
});

describe('ui-card doc: setContent + onClick', () => {
  it('Card.setContent sizes content to the card', () => {
    const scene = makeScene();
    const card = new Card({
      width: 300,
      height: 200,
      padding: 16,
      label: 'Demo card',
    });
    scene.add(card);
    const inner = new Rect({ width: 50, height: 50, fill: '#6366f1' });
    card.setContent(inner, true);
    expect(inner.width).toBe(300); // sized to card content box width
  });

  it('Card.onClick fires via emit', () => {
    const scene = makeScene();
    let clicked: any = null;
    const card = new Card({
      width: 200,
      height: 100,
      label: 'Click me',
      onClick: () => {
        clicked = card;
      },
    });
    scene.add(card);
    expect(card.interactive).toBe(true);
    card.emit('click', { type: 'click', target: card });
    expect(clicked).toBe(card);
  });
});

describe('ui-text doc: Text component', () => {
  it('Text renders content with maxWidth', () => {
    const scene = makeScene();
    const label = new Text('Hello VectoJS', {
      font: '24px sans-serif',
      maxWidth: 400,
    });
    scene.add(label);
    expect(label.text).toBe('Hello VectoJS');
    expect(label.height).toBeGreaterThan(0);
  });

  it('Text.append extends content incrementally', () => {
    const scene = makeScene();
    const label = new Text('Hello', { font: '16px sans-serif', maxWidth: 300 });
    scene.add(label);
    label.append(' world');
    expect(label.text).toBe('Hello world');
  });

  it('Text.setMaxWidth reflows without re-measuring', () => {
    const scene = makeScene();
    const label = new Text('A longer line of text that should wrap', {
      font: '16px sans-serif',
      maxWidth: 400,
    });
    scene.add(label);
    const h1 = label.height;
    label.setMaxWidth(100);
    expect(label.height).toBeGreaterThan(h1);
  });
});

// --- devtools-perf.md ------------------------------------------------------

describe('devtools-perf doc: the 0.11.0 Markdown metric rename', () => {
  it('exposes the current field names and none of the removed ones', () => {
    const scene = makeScene();
    const md = new Markdown('# Title\n\nA paragraph.', 400);
    scene.add(md);
    md.appendMarkdown(' More text.');

    const info = inspectMarkdownStream(md);
    expect(info).not.toBeNull();

    // Documented as current in 0.11.0.
    expect(info).toHaveProperty('tokensPrefixMatched');
    expect(info).toHaveProperty('tokensReturned');
    expect(info).toHaveProperty('tokenPrefixReuseRatio');
    expect(info).toHaveProperty('lexerMs');
    expect(info).toHaveProperty('sourceCharsLexed');

    // Documented as REMOVED, not aliased. If any of these comes back, the
    // reference page's migration table is wrong.
    expect(info).not.toHaveProperty('tokensReused');
    expect(info).not.toHaveProperty('tokensRelexed');
    expect(info).not.toHaveProperty('reuseRatio');
  });

  it('isMarkdownEntity duck-types on the descriptor, not instanceof', () => {
    const md = new Markdown('text', 200);
    expect(isMarkdownEntity(md)).toBe(true);
    expect(isMarkdownEntity(new Box(10, 10))).toBe(false);
  });

  it('auditGpu is silent until draw counting is enabled', () => {
    const scene = makeScene();
    scene.add(new Box(50, 50));
    scene.step(16.67);
    // The documented trap: a clean result here is absence of data, not health.
    expect(auditGpu(scene)).toEqual([]);
  });

  it('diagnoseDirty reports tracking-off rather than throwing', () => {
    const scene = makeScene();
    const diag = diagnoseDirty(scene);
    expect(diag.causes).toEqual([]);
    expect(diag.summary).toContain('setDirtyTracking');
  });

  it('inspectAccelerators always reports all four, with faulted = rejected only', () => {
    const scene = makeScene();
    const info = inspectAccelerators(scene);
    expect(info.accelerators.map((a) => a.accelerator)).toEqual([
      'transform',
      'animation',
      'hitTest',
      'particle',
    ]);
    for (const a of info.accelerators) {
      expect(a.faulted).toBe(a.reason === 'rejected');
    }
    // A JS-only scene audits clean: a shut gate is not a fault.
    expect(auditAccelerators(scene)).toEqual([]);
  });
});

// --- devtools-extend.md ---------------------------------------------------

describe('devtools-extend doc: bridge wiring', () => {
  it('the documented direct-pair example round-trips', async () => {
    const scene = makeScene();
    scene.add(new Box(40, 40));

    const { backend, frontend } = createDirectTransportPair();
    const server = createDevtoolsBackend(scene, backend);
    const client = createDevtoolsClient(frontend, { timeoutMs: 500 });

    const { version } = await client.request<{ version: number }>('protocol.version');
    expect(version).toBe(DEVTOOLS_PROTOCOL_VERSION);
    expect(DEVTOOLS_PROTOCOL_VERSION).toBe(1);
    expect(DEVTOOLS_CHANNEL).toBe('vectojs-devtools');

    const tree = await client.request<{ truncated: boolean }>('tree.get');
    expect(tree.truncated).toBe(false);

    server.dispose();
    client.dispose();
  });

  it('rejects an unknown method instead of resolving undefined', async () => {
    const scene = makeScene();
    const { backend, frontend } = createDirectTransportPair();
    const server = createDevtoolsBackend(scene, backend);
    const client = createDevtoolsClient(frontend, { timeoutMs: 500 });

    await expect(
      client.request('does.not.exist' as Parameters<typeof client.request>[0]),
    ).rejects.toThrow(/unknown method/);

    server.dispose();
    client.dispose();
  });

  it('scene.diff advances its own baseline, as documented', async () => {
    const scene = makeScene();
    const box = new Box(30, 30);
    scene.add(box);

    const { backend, frontend } = createDirectTransportPair();
    const server = createDevtoolsBackend(scene, backend);
    const client = createDevtoolsClient(frontend, { timeoutMs: 500 });

    await client.request('scene.snapshot');
    box.setPosition(10, 0);
    const first = await client.request<unknown[]>('scene.diff');
    expect(first.length).toBeGreaterThan(0);
    // Nothing moved since; the baseline advanced, so this is empty rather
    // than repeating the first diff.
    const second = await client.request<unknown[]>('scene.diff');
    expect(second).toEqual([]);

    server.dispose();
    client.dispose();
  });
});

describe('devtools-extend doc: plugin protocol', () => {
  it('namespaces audit findings and contains a throwing audit', () => {
    clearDevtoolsPlugins();
    const scene = makeScene();
    const unregister = registerDevtoolsPlugin({
      id: 'my-chart',
      audits: [
        {
          id: 'data',
          run: () => [{ kind: 'empty-series', message: 'no data' }],
        },
        {
          id: 'boom',
          run: () => {
            throw new Error('plugin bug');
          },
        },
      ],
    });

    const findings = runPluginAudits({ scene, selection: null });
    expect(findings.map((f) => f.kind)).toContain('my-chart/empty-series');
    const failed = findings.find((f) => f.kind === 'my-chart/audit-failed');
    expect(failed?.severity).toBe('error');

    unregister();
    expect(runPluginAudits({ scene, selection: null })).toEqual([]);
    clearDevtoolsPlugins();
  });

  it('an inspector with no selection returns the sentinel row, not a throw', () => {
    const scene = makeScene();
    const inspector = {
      id: 'chart',
      label: 'Chart',
      rows: () => [{ label: 'series', value: '3' }],
    };
    const rows = runPluginInspector(inspector, { scene, selection: null });
    expect(rows).toEqual([{ label: '—', value: 'no selection' }]);
  });

  it("an unknown command throws rather than silently no-op'ing", () => {
    const scene = makeScene();
    clearDevtoolsPlugins();
    expect(() => runPluginCommand('nope/nope', { scene, selection: null })).toThrow(
      /no DevTools command/,
    );
  });
});

// --- devtools-inspect.md --------------------------------------------------

describe('devtools-inspect doc: highlight geometry and hit explanation', () => {
  it("'hit' is not a default layer, and layers come back in fixed order", () => {
    const scene = makeScene();
    const box = new Box(60, 40);
    scene.add(box);

    const kinds = highlightGeometry(scene, box).map((l) => l.kind);
    expect(kinds).not.toContain('hit');
    // Requesting in a different order still returns the canonical order.
    const asked = highlightGeometry(scene, box, { layers: ['clip', 'aabb'] });
    expect(asked.map((l) => l.kind)).toEqual(['aabb', 'clip']);
  });

  it('sampleHitRegion diverges on a shape that fills its box by area, not extent', () => {
    const circle = new Circle({ radius: 30 });
    circle.setPosition(0, 0);
    const layer = sampleHitRegion(circle, { step: 4 });
    // An inscribed circle has the box's full extent but ~79% of its area.
    expect(layer.divergesFromLayout).toBe(true);

    const box = new Box(60, 60);
    expect(sampleHitRegion(box, { step: 4 }).divergesFromLayout).toBeUndefined();
  });

  it('refuses to sample past its probe budget instead of hanging', () => {
    const huge = new Box(4000, 4000);
    const layer = sampleHitRegion(huge, { step: 1 });
    expect(layer.polygons).toEqual([]);
    expect(layer.unavailable).toMatch(/budget/);
  });

  it('explainHitTest rewrites a loser under the winner as occluded', () => {
    const scene = makeScene();
    const under = new Box(100, 100);
    const over = new Box(100, 100);
    under.interactive = true;
    over.interactive = true;
    scene.add(under);
    scene.add(over); // later sibling paints on top

    const why = explainHitTest(scene, 50, 50);
    expect(why.hitId).toBe(over.id);
    expect(why.root).toBe('main');
    const loser = why.candidates.find((c) => c.entityId === under.id);
    expect(loser?.verdict).toBe('occluded');
    // The documented header shape: `hit test (x, y) -> <path> [<root>]`.
    expect(formatHitExplanation(why)[0]).toBe(`hit test (50, 50) → ${why.hitPath} [main]`);
    // Documented: lines carry `type`, not the path, prefixed by a verdict glyph.
    expect(formatHitExplanation(why).some((l) => l.includes('· Box —'))).toBe(true);
  });

  it('inspectEntity omits absent optional fields rather than setting undefined', () => {
    const scene = makeScene();
    const box = new Box(20, 20);
    scene.add(box);
    const info = inspectEntity(box);
    // A Box has no text, so the key is absent — which is how a caller tells
    // "no text" from "empty text".
    expect('text' in info).toBe(false);
  });
});

// --- devtools-audit.md ---------------------------------------------------

describe('devtools-audit doc: sorting and a11y findings', () => {
  it('auditScene sorts by kind then path, deterministically', () => {
    const scene = makeScene();
    for (let i = 0; i < 3; i++) {
      const b = new Box(100, 40);
      b.setPosition(0, i * 20); // each overlaps the next
      scene.add(b);
    }
    const kinds = auditScene(scene).map((f) => f.kind);
    expect([...kinds].sort((a, b) => a.localeCompare(b))).toEqual(kinds);
  });

  it('auditA11y reports an interactive entity with no accessible name', () => {
    const scene = makeScene();
    const box = new Box(40, 40);
    box.interactive = true;
    scene.add(box);
    const findings = auditA11y(scene);
    expect(findings.some((f) => f.kind === 'no-accessible-name')).toBe(true);
  });
});
