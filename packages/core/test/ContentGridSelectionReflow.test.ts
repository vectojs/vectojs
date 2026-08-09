// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { prepareContentGrid } from '@vectojs/text';
import { Entity, Scene } from '../src/index';
import type { ContentProjection } from '../src/tree/Entity';

/**
 * A selection must survive a **reflow**: the characters are still on screen, only
 * the line breaks moved.
 *
 * This is the other half of `ContentGridSelectionWindow.test.ts`. That suite pins
 * the cases where a carrier line's text genuinely leaves the projection (the
 * window scrolled past it) and the selection must be dropped. A reflow — a resize,
 * a font change, a device-pixel-ratio change — also replaces every carrier line,
 * but for the opposite reason: the same source characters are re-broken across new
 * lines. Releasing there wipes a selection the user can still see, which is the
 * defect reported as #430 ("resizing or zooming the window clears my selection").
 *
 * The two are told apart by SOURCE offsets. Carrier cells record
 * `data-vecto-grid-source-start`/`-length`, which are stable against line breaking
 * and against the carrier window, so an endpoint that still exists resolves and one
 * that scrolled away does not.
 */

const LINE_HEIGHT = 16;
/** Wide enough that the whole grid fits the band, so nothing is windowed away. */
const SHORT_LINE_COUNT = 4;

/** A grid entity whose line breaking is driven by a mutable cell width. */
class ReflowGridEntity extends Entity {
  public text: string;
  /** Changing this re-breaks every line without changing a single character. */
  public cellWidth = 8;

  constructor(text: string) {
    super();
    this.text = text;
    this.width = 400;
    this.height = SHORT_LINE_COUNT * LINE_HEIGHT;
  }

  public override getContentProjection(): ContentProjection {
    const grid = prepareContentGrid(this.text, {
      cellWidth: this.cellWidth,
      lineHeight: LINE_HEIGHT,
      baseline: 12,
      font: '15px monospace',
      measureCell: () => this.cellWidth,
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
  // makes calibration scheduling a no-op, isolating the selection logic under
  // test. Same harness as `ContentGridSelectionWindow.test.ts`.
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

/** The selected text as the browser would copy it, or `''` with no selection. */
function selectedText(): string {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) return '';
  return selection.toString();
}

function hasSelection(): boolean {
  const selection = window.getSelection();
  return !!selection && selection.rangeCount > 0;
}

/**
 * Select the source range `[from, to)` through the carrier cells that hold it,
 * exactly as a drag would land.
 */
function selectSourceRange(el: HTMLElement, from: number, to: number): void {
  const cellFor = (offset: number): { node: Text; offset: number } => {
    for (const cell of el.querySelectorAll<HTMLElement>('[data-vecto-grid-cell]')) {
      const start = Number(cell.dataset.vectoGridSourceStart);
      const length = Number(cell.dataset.vectoGridSourceLength ?? 0);
      if (offset >= start && offset <= start + length) {
        const node = cell.firstChild;
        if (node instanceof Text) return { node, offset: offset - start };
      }
    }
    throw new Error(`source offset ${offset} is not projected`);
  };
  const anchor = cellFor(from);
  const focus = cellFor(to);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.setBaseAndExtent(anchor.node, anchor.offset, focus.node, focus.offset);
}

describe('content grid selection across a reflow', () => {
  let scene: Scene;
  let entity: ReflowGridEntity;
  let el: HTMLElement;

  beforeEach(() => {
    window.getSelection()?.removeAllRanges();
    scene = makeScene();
    entity = new ReflowGridEntity('alpha beta gamma delta');
    scene.add(entity);
    entity.y = 0;
    sync(scene);
    el = scene.getContentElement(entity.id) as HTMLElement;
  });

  it('keeps the selected characters when a reflow rebuilds every line', () => {
    // `beta` — a word away from both ends, so an off-by-one restore is visible.
    selectSourceRange(el, 6, 10);
    expect(selectedText()).toBe('beta');

    // A cell-width change re-measures and re-breaks the grid: `grid.revision`
    // moves, every line signature changes, and no carrier is reused. This is what
    // a window resize, a font swap, and a device-pixel-ratio change all do.
    entity.cellWidth = 11;
    sync(scene);

    expect(hasSelection()).toBe(true);
    expect(selectedText()).toBe('beta');
  });

  it('keeps a collapsed caret across a reflow', () => {
    selectSourceRange(el, 6, 6);
    expect(hasSelection()).toBe(true);

    entity.cellWidth = 11;
    sync(scene);

    const selection = window.getSelection();
    expect(selection?.rangeCount).toBe(1);
    expect(selection?.isCollapsed).toBe(true);
  });

  it('leaves an unselected document alone through a reflow', () => {
    // Guards the restore path from being reached at all when there is nothing to
    // restore: no selection must not become an empty selection.
    entity.cellWidth = 11;
    sync(scene);

    expect(hasSelection()).toBe(false);
  });
});
