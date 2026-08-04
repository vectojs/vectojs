// @vitest-environment jsdom
/**
 * Per-line content-projection virtualization (CTX-0195).
 *
 * `projectionBoxVisible` gates whole entities, which cannot help an entity
 * TALLER than the viewport: its box always intersects, so every line was
 * materialized. These tests pin the line-level window that bounds it, and — more
 * importantly — pin the properties the window must not break, because a window
 * that drops text silently breaks selection, find-in-page and, for static text,
 * the screen reader.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { Entity } from '../src/tree/Entity';
import { Scene } from '../src/tree/Scene';

const VIEW_W = 400;
const VIEW_H = 300;
const LINE_H = 20;

interface ProjLine {
  text: string;
  x: number;
  y: number;
  baseline: number;
  lineHeight: number;
}

/** A text entity of `lineCount` lines, taller than the viewport. */
class TallText extends Entity {
  constructor(
    id: string,
    private readonly lineCount: number,
  ) {
    super(id);
    this.width = 200;
    this.height = lineCount * LINE_H;
  }

  isPointInside(): boolean {
    return false;
  }

  render(): void {}

  public lines(): ProjLine[] {
    const out: ProjLine[] = [];
    for (let i = 0; i < this.lineCount; i++) {
      out.push({
        text: `line${i}`,
        x: 0,
        y: i * LINE_H,
        baseline: 14,
        lineHeight: LINE_H,
      });
    }
    return out;
  }

  override getContentProjection() {
    const lines = this.lines();
    return {
      text: lines.map((l) => l.text).join('\n'),
      font: '16px sans-serif',
      lineHeight: LINE_H,
      selectable: true,
      lines,
    };
  }
}

function makeScene(options: Record<string, unknown> = {}): Scene {
  const parent = document.createElement('div');
  const canvas = document.createElement('canvas');
  canvas.width = VIEW_W;
  canvas.height = VIEW_H;
  parent.appendChild(canvas);
  document.body.appendChild(parent);
  const scene = new Scene(canvas, options);
  (scene as unknown as { isRunning: boolean }).isRunning = true;
  return scene;
}

function sync(scene: Scene): void {
  const s = scene as unknown as {
    syncA11y: (r: unknown) => void;
    root: unknown;
  };
  s.syncA11y(s.root);
}

function el(scene: Scene, id: string): HTMLElement | undefined {
  return scene.getContentElement(id);
}

describe('per-line content projection window', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('materializes every line when the document fits the band', () => {
    const scene = makeScene({ contentProjectionMargin: VIEW_H });
    // 5 lines = 100px, far inside one viewport + margin.
    const e = new TallText('short', 5);
    e.setPosition(0, 0);
    scene.add(e);
    sync(scene);

    const node = el(scene, 'short')!;
    expect(node.children.length).toBe(5);
    // Not windowed, so no marker and the full text is present.
    expect(node.dataset.vectoProjectionWindow).toBeUndefined();
    expect(node.textContent).toContain('line0');
    expect(node.textContent).toContain('line4');
    scene.destroy();
  });

  it('materializes only the visible band for a document far taller than the viewport', () => {
    const scene = makeScene({ contentProjectionMargin: VIEW_H });
    const e = new TallText('tall', 500); // 10,000px tall
    e.setPosition(0, 0);
    scene.add(e);
    sync(scene);

    const node = el(scene, 'tall')!;
    // Band is viewport + margin either side = 300 + 300 = 600px below origin,
    // so ~30 of 500 lines. Assert it is bounded, not an exact count, since the
    // band arithmetic is the thing under test elsewhere.
    expect(node.children.length).toBeLessThan(60);
    expect(node.children.length).toBeGreaterThan(0);
    expect(node.dataset.vectoProjectionWindow).toBeDefined();
    expect(node.dataset.vectoProjectionWindow).toMatch(/^\d+-\d+\/500$/);
    scene.destroy();
  });

  it('keeps the window contiguous so selection cannot splice out text', () => {
    const scene = makeScene({ contentProjectionMargin: VIEW_H });
    const e = new TallText('tall', 400);
    e.setPosition(0, 0);
    scene.add(e);
    sync(scene);

    const node = el(scene, 'tall')!;
    // Every materialized line must be consecutive: a gap would let a drag from
    // above it to below it silently omit the lines in between.
    const indices = Array.from(node.children).map((child) =>
      Number((child as HTMLElement).textContent?.replace(/\D+/g, '')),
    );
    for (let i = 1; i < indices.length; i++) {
      expect(indices[i]).toBe(indices[i - 1] + 1);
    }
    scene.destroy();
  });

  it('moves the window when the entity scrolls', () => {
    const scene = makeScene({ contentProjectionMargin: VIEW_H });
    const e = new TallText('tall', 500);
    e.setPosition(0, 0);
    scene.add(e);
    sync(scene);
    const first = el(scene, 'tall')!.dataset.vectoProjectionWindow;
    const firstText = el(scene, 'tall')!.textContent ?? '';

    // Scroll the entity up by 4000px: a different band becomes visible.
    e.setPosition(0, -4000);
    sync(scene);
    const second = el(scene, 'tall')!.dataset.vectoProjectionWindow;
    const secondText = el(scene, 'tall')!.textContent ?? '';

    expect(second).not.toBe(first);
    expect(secondText).not.toBe(firstText);
    // The new band is deeper into the document.
    expect(secondText).toContain('line200');
    expect(firstText).not.toContain('line200');
    scene.destroy();
  });

  it('projects every line when the gate is disabled with an infinite margin', () => {
    const scene = makeScene({ contentProjectionMargin: Infinity });
    const e = new TallText('tall', 120);
    e.setPosition(0, 0);
    scene.add(e);
    sync(scene);

    const node = el(scene, 'tall')!;
    // Infinity is the documented "materialize everything" escape hatch; per-line
    // gating must honour it or that option silently stops working.
    expect(node.children.length).toBe(120);
    expect(node.dataset.vectoProjectionWindow).toBeUndefined();
    scene.destroy();
  });

  it('never projects zero lines, even when the band misses every line', () => {
    const scene = makeScene({ contentProjectionMargin: 0 });
    const e = new TallText('tall', 200);
    // Positioned so no line's box overlaps a zero-margin viewport band.
    e.setPosition(0, -100_000);
    scene.add(e);
    sync(scene);

    const node = el(scene, 'tall');
    // Either released by the entity-level box gate, or kept with at least one
    // line — but never present-and-empty, which would read as "this text does
    // not exist" to find-in-page and a screen reader.
    if (node) expect(node.children.length).toBeGreaterThan(0);
    scene.destroy();
  });

  it('emits a separator on the window\u2019s last line because the document continues', () => {
    const scene = makeScene({ contentProjectionMargin: VIEW_H });
    const e = new TallText('tall', 500);
    e.setPosition(0, 0);
    scene.add(e);
    sync(scene);

    const node = el(scene, 'tall')!;
    const last = node.lastElementChild as HTMLElement;
    // The window's final line is not the document's final line, so it keeps its
    // newline; dropping it would join two lines in a copy that spans the edge.
    expect(last.textContent?.endsWith('\n')).toBe(true);
    scene.destroy();
  });

  it('keeps the projected text a subset of the full projection text', () => {
    const scene = makeScene({ contentProjectionMargin: VIEW_H });
    const e = new TallText('tall', 300);
    e.setPosition(0, -2000);
    scene.add(e);
    sync(scene);

    const node = el(scene, 'tall')!;
    const full = e.getContentProjection().text;
    const shown = node.textContent ?? '';
    expect(shown.length).toBeGreaterThan(0);
    // Containment, not equality: the window is a deliberate subset, but it must
    // never contain text the entity does not actually render.
    expect(full).toContain(shown);
    scene.destroy();
  });

  it('passes a hint whose band matches the window it will materialize', () => {
    const scene = makeScene({ contentProjectionMargin: VIEW_H });
    let seen: { minY?: number; maxY?: number } | undefined;
    class Probe extends TallText {
      override getContentProjection(hint?: { minY?: number; maxY?: number }) {
        seen = hint;
        return super.getContentProjection();
      }
    }
    const e = new Probe('probe', 500);
    e.setPosition(0, -2000);
    scene.add(e);
    sync(scene);

    // The hint is what lets an O(glyphs) entity become O(visible glyphs); without
    // it the window saves DOM but not build time (measured Chrome 1.1x).
    expect(seen).toBeDefined();
    expect(seen!.minY).toBeTypeOf('number');
    expect(seen!.maxY).toBeTypeOf('number');
    // Entity is 2000px up, so the visible band starts around there.
    expect(seen!.minY!).toBeGreaterThan(1000);
    expect(seen!.maxY!).toBeGreaterThan(seen!.minY!);
    scene.destroy();
  });

  it('omits the hint when no useful bound exists so nothing is dropped', () => {
    const scene = makeScene({ contentProjectionMargin: Infinity });
    let called = false;
    let seen: unknown = 'unset';
    class Probe extends TallText {
      override getContentProjection(hint?: { minY?: number; maxY?: number }) {
        called = true;
        seen = hint;
        return super.getContentProjection();
      }
    }
    const e = new Probe('probe', 50);
    scene.add(e);
    sync(scene);

    // An infinite margin means "materialize everything", so passing a band would
    // silently re-enable gating through the entity and defeat that option.
    expect(called).toBe(true);
    expect(seen).toBeUndefined();
    scene.destroy();
  });

  it('does not rebuild the DOM when a scroll stays inside the same line', () => {
    const scene = makeScene({ contentProjectionMargin: VIEW_H });
    const e = new TallText('tall', 500);
    e.setPosition(0, 0);
    scene.add(e);
    sync(scene);

    const node = el(scene, 'tall')!;
    const before = node.firstElementChild;
    const windowBefore = node.dataset.vectoProjectionWindow;

    // A sub-line scroll must not change the window, or every pointer-driven
    // pixel of scrolling would churn the whole carrier set.
    e.setPosition(0, -1);
    sync(scene);

    expect(node.dataset.vectoProjectionWindow).toBe(windowBefore);
    expect(node.firstElementChild).toBe(before); // same instance, not rebuilt
    scene.destroy();
  });
});
