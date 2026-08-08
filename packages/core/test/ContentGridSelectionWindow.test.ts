// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { prepareContentGrid } from '@vectojs/text';
import { Entity, Scene } from '../src/index';
import type { ContentProjection } from '../src/tree/Entity';

/**
 * A live text selection must not survive the carrier line holding it being
 * replaced — a `Selection` left pointing into a detached node reports a stale
 * `contentGridSelectionLine` and copies the wrong text.
 *
 * The grid path windows its carriers to the interaction band, so scrolling moves
 * which lines exist. Two directions lose a line's carrier, and they take
 * different code paths:
 *
 * - the window's END moves past the selection: the trim loop removes the tail;
 * - the window's START moves past the selection: nothing is trimmed at all (the
 *   window keeps its length), and the materialize loop instead overwrites
 *   `children[0..]` with the new window's lines.
 *
 * The second was unguarded. These tests pin both, plus the over-release
 * direction that matters more in practice: a selection in a REUSED line must
 * survive a streaming append, which is the whole reason the grid path reuses
 * lines instead of calling `replaceChildren()`.
 */

/** Lines tall enough that the window is always a strict subset. */
const LINE_COUNT = 100;
const LINE_HEIGHT = 16;

class TallGridEntity extends Entity {
  public text: string;

  constructor(text: string) {
    super();
    this.text = text;
    this.width = 400;
    this.height = LINE_COUNT * LINE_HEIGHT;
  }

  public override getContentProjection(): ContentProjection {
    const grid = prepareContentGrid(this.text, {
      cellWidth: 8,
      lineHeight: LINE_HEIGHT,
      baseline: 12,
      font: '15px monospace',
      measureCell: () => 8,
    });
    return {
      text: this.text,
      font: '15px monospace',
      lineHeight: LINE_HEIGHT,
      grid,
      selectable: true,
    } as ContentProjection;
  }

  public override getBounds() {
    return { x: 0, y: this.y, width: this.width, height: this.height };
  }

  public override render(): void {}
}

function makeScene(): Scene {
  // Grid calibration runs in a deferred rAF and measures real text through
  // `Range.getBoundingClientRect`, which jsdom does not implement. Removing rAF
  // makes `scheduleContentGridCalibration` a no-op, isolating the windowing
  // logic under test. Same harness as `ContentGridPromotion.test.ts`.
  (globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame = undefined;

  const canvas = document.createElement('canvas');
  canvas.width = 600;
  canvas.height = 400;
  (canvas as unknown as { getContext: () => unknown }).getContext = () => ({
    measureText: (t: string) => ({ width: String(t).length * 8 }),
    canvas,
    save() {},
    restore() {},
    translate() {},
    scale() {},
    clearRect() {},
    fillRect() {},
    fillText() {},
    beginPath() {},
    setTransform() {},
    getTransform: () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }),
  });
  document.body.appendChild(canvas);
  const scene = new Scene(canvas, {
    disableWindowResize: true,
    contentProjectionMargin: 100,
  } as ConstructorParameters<typeof Scene>[1]);
  scene.resize(600, 400);
  return scene;
}

/** Force a full a11y + content projection pass, which `step()` does not do. */
function sync(scene: Scene): void {
  (scene as unknown as { syncA11y: (n: unknown) => void }).syncA11y(
    (scene as unknown as { root: unknown }).root,
  );
}

function gridLine(el: HTMLElement, lineIndex: number): HTMLElement | null {
  return el.querySelector(`[data-vecto-grid-line="${lineIndex}"]`);
}

/** Half-open window of line indices currently materialized. */
function windowOf(el: HTMLElement): { start: number; end: number } {
  const raw = el.dataset.vectoProjectionWindow;
  if (raw === undefined) throw new Error('expected a gated window');
  const [range] = raw.split('/');
  const [start, end] = range.split('-').map(Number);
  return { start, end };
}

/** Anchor a real collapsed selection inside line `lineIndex`'s first text node. */
function selectInLine(el: HTMLElement, lineIndex: number): Text {
  const line = gridLine(el, lineIndex);
  if (!line) throw new Error(`line ${lineIndex} is not materialized`);
  const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
  const text = walker.nextNode() as Text | null;
  if (!text) throw new Error(`line ${lineIndex} has no text node`);
  const range = document.createRange();
  range.setStart(text, 0);
  range.setEnd(text, Math.min(1, text.length));
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
  return text;
}

function selectionLineOf(scene: Scene, el: HTMLElement): number | null {
  return (
    scene as unknown as {
      contentGridSelectionLine: (e: HTMLElement) => number | null;
    }
  ).contentGridSelectionLine(el);
}

function hasSelection(): boolean {
  const selection = window.getSelection();
  return !!selection && selection.rangeCount > 0;
}

function source(lineCount: number, marker = ''): string {
  return Array.from({ length: lineCount }, (_, i) => `line ${i} content${marker}`).join('\n');
}

describe('content grid selection release across a moving window', () => {
  let scene: Scene;
  let entity: TallGridEntity;
  let el: HTMLElement;

  beforeEach(() => {
    window.getSelection()?.removeAllRanges();
    scene = makeScene();
    entity = new TallGridEntity(source(LINE_COUNT));
    scene.add(entity);
    entity.y = 0;
    sync(scene);
    el = scene.getContentElement(entity.id) as HTMLElement;
  });

  it('windows its carriers, so the window can move over a selection at all', () => {
    // Guards every test below from passing because nothing was ever gated.
    const { start, end } = windowOf(el);
    expect(start).toBe(0);
    expect(end).toBeLessThan(LINE_COUNT);
  });

  it('releases a selection when the window start moves past it', () => {
    selectInLine(el, 5);
    expect(selectionLineOf(scene, el)).toBe(5);

    // Scroll so line 5 falls off the TOP of the band. Nothing is trimmed here —
    // the window keeps its length — so only the hoisted bounds check notices.
    entity.y = -800;
    sync(scene);

    const { start } = windowOf(el);
    expect(start).toBeGreaterThan(5);
    expect(gridLine(el, 5)).toBeNull();
    expect(hasSelection()).toBe(false);
    expect(selectionLineOf(scene, el)).toBeNull();
  });

  it('releases a selection when the window end moves past it', () => {
    const { end } = windowOf(el);
    const selected = end - 1;
    selectInLine(el, selected);
    expect(selectionLineOf(scene, el)).toBe(selected);

    // Push the block DOWN so its tail leaves the band and the window shortens.
    // Deliberately a modest offset: scrolling far enough to leave the
    // interaction margin entirely demotes the block to the coarse tier and
    // releases the element, which asserts against a detached node instead of the
    // trim path under test.
    entity.y = 300;
    sync(scene);

    expect(windowOf(el).end).toBeLessThanOrEqual(selected);
    expect(gridLine(el, selected)).toBeNull();
    expect(hasSelection()).toBe(false);
    expect(selectionLineOf(scene, el)).toBeNull();
  });

  it('keeps a selection in a reused line across a streaming append', () => {
    // The over-release direction, and the more important of the two: reuse of
    // unchanged carrier lines is what makes streaming affordable, and wiping the
    // selection every frame is the bug that reuse exists to avoid.
    selectInLine(el, 3);
    expect(selectionLineOf(scene, el)).toBe(3);

    entity.text = `${entity.text}\nappended tail line`;
    sync(scene);

    expect(gridLine(el, 3)).not.toBeNull();
    expect(hasSelection()).toBe(true);
    expect(selectionLineOf(scene, el)).toBe(3);
  });

  it('keeps a selection when the window does not move at all', () => {
    selectInLine(el, 4);
    // A no-op sync must not disturb anything; the rebuild is signature-gated, so
    // this also pins that the new check is not evaluated on an untouched grid.
    sync(scene);
    sync(scene);

    expect(hasSelection()).toBe(true);
    expect(selectionLineOf(scene, el)).toBe(4);
  });
});
