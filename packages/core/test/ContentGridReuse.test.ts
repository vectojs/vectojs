// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { prepareContentGrid } from '@vectojs/text';
import { Entity, Scene } from '../src/index';
import type { ContentProjection } from '../src/tree/Entity';

/**
 * Carrier reuse in the content-grid projection.
 *
 * Streaming text bumps `grid.revision` on every append. Before reuse, the
 * projection called `replaceChildren()` and rebuilt one `<span>` per cell each
 * time, which measured 898-1431 ms of `gridMaterialize` per run (53% of
 * `a11ySync` on Chrome, 79% on Firefox) while a streamed code block dropped a
 * third of its input chunks.
 *
 * These tests pin the two properties that make reuse safe rather than merely
 * fast: an unchanged line keeps its DOM node identity, and ANY change to the
 * geometry or source a carrier encodes must produce a new node. The second is the
 * dangerous direction — a stale carrier does not look wrong, it silently
 * desynchronizes DOM Range offsets from the source, breaking selection and
 * screen-reader position.
 */
class GridEntity extends Entity {
  public text: string;
  public cellWidth = 8;
  public lineHeight = 16;

  constructor(text: string) {
    super();
    this.text = text;
  }

  public override getContentProjection(): ContentProjection {
    const grid = prepareContentGrid(this.text, {
      cellWidth: this.cellWidth,
      lineHeight: this.lineHeight,
      baseline: 12,
      font: '15px monospace',
      measureCell: () => this.cellWidth,
    });
    return {
      text: this.text,
      font: '15px monospace',
      lineHeight: this.lineHeight,
      grid,
      selectable: true,
      textRendering: 'none',
    } as ContentProjection;
  }

  public override getBounds() {
    return { x: 0, y: 0, width: 400, height: 200 };
  }

  public override render(): void {}
}

function makeScene(): { scene: Scene; canvas: HTMLCanvasElement } {
  // Suppress grid calibration for the duration of these tests.
  //
  // Calibration runs in a deferred rAF and measures real text with
  // `Range.getBoundingClientRect`, which jsdom does not implement — it throws
  // asynchronously, after the test that scheduled it has finished, so the suite
  // reports passing tests alongside a pile of unhandled errors and a non-zero
  // exit. `scheduleContentGridCalibration` no-ops when `requestAnimationFrame` is
  // absent, so removing it isolates carrier reuse, which is what is under test
  // here. Calibration itself is covered by `e2e/text-projection.e2e.ts` in a real
  // browser, which is the only place it can be exercised honestly.
  (globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame = undefined;

  const canvas = document.createElement('canvas');
  canvas.width = 600;
  canvas.height = 400;
  // jsdom has no 2D context; the projection path only needs measureText.
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
  const scene = new Scene(canvas, { disableWindowResize: true });
  scene.resize(600, 400);
  return { scene, canvas };
}

/** Force a full a11y + content projection pass, which `step()` does not do. */
function syncProjection(scene: Scene): void {
  (scene as unknown as { syncA11y: (n: unknown) => void }).syncA11y(
    (scene as unknown as { root: unknown }).root,
  );
}

function lineElements(scene: Scene, entity: Entity): HTMLElement[] {
  const el = scene.getContentElement(entity.id) as HTMLElement | null;
  return el ? ([...el.children] as HTMLElement[]) : [];
}

function cellTexts(line: HTMLElement): string[] {
  return [...line.querySelectorAll<HTMLElement>('[data-vecto-grid-cell]')].map(
    (c) => c.textContent ?? '',
  );
}

describe('content grid carrier reuse', () => {
  let scene: Scene;

  beforeEach(() => {
    ({ scene } = makeScene());
  });

  it('keeps DOM identity for lines unchanged by an append', () => {
    const entity = new GridEntity('const a = 1;\nconst b = 2;');
    scene.add(entity);
    syncProjection(scene);
    const projectionEl = scene.getContentElement(entity.id) as HTMLElement;
    const before = lineElements(scene, entity);
    expect(before.length).toBe(2);

    entity.text += '\nconst c = 3;';
    syncProjection(scene);
    const after = lineElements(scene, entity);

    // The projection element itself must persist, or child identity is moot.
    expect(scene.getContentElement(entity.id)).toBe(projectionEl);
    expect(after.length).toBe(3);
    // Line 0 must be the SAME node, not an equal copy. That identity is the point:
    // it keeps a live selection and avoids the per-cell createElement storm.
    expect(after[0]).toBe(before[0]);
    // Line 1 is legitimately rebuilt, and this is worth pinning rather than
    // asserting away. A grid line owns the hard break that FOLLOWS it
    // (`nextSourceStart`), so appending a third line changes what was the last
    // line: its break text goes from '' to '\n', shifting `nextSourceStart` 7 -> 8.
    // Its carriers really do change, and a signature that ignored the break would
    // wrongly reuse it and leave the DOM missing a newline for copy and find.
    expect(after[1]).not.toBe(before[1]);
    expect(after.length).toBe(3);
  });

  it('rebuilds only the line whose text changed', () => {
    const entity = new GridEntity('aaa\nbbb\nccc');
    scene.add(entity);
    syncProjection(scene);
    const before = lineElements(scene, entity);

    entity.text = 'aaa\nbXb\nccc';
    syncProjection(scene);
    const after = lineElements(scene, entity);

    expect(after[0]).toBe(before[0]);
    expect(after[1]).not.toBe(before[1]);
    expect(after[2]).toBe(before[2]);
    expect(cellTexts(after[1]!).join('')).toContain('X');
  });

  it('removes carriers when the grid shrinks', () => {
    const entity = new GridEntity('one\ntwo\nthree\nfour');
    scene.add(entity);
    syncProjection(scene);
    expect(lineElements(scene, entity).length).toBe(4);

    entity.text = 'one\ntwo';
    syncProjection(scene);
    const after = lineElements(scene, entity);
    expect(after.length).toBe(2);
    // A stale carrier past the end would stay visible to a screen reader and to
    // copy/find even though nothing paints it.
    expect(after.map((l) => cellTexts(l).join('')).join('|')).not.toContain('three');
  });

  it('rebuilds a line when only its geometry changes', () => {
    const entity = new GridEntity('aaa\nbbb');
    scene.add(entity);
    syncProjection(scene);
    const before = lineElements(scene, entity);

    // Same source text, different cell advance: the carriers' widths and x offsets
    // must follow, or DOM selection geometry drifts from the canvas while the text
    // still matches. This is the case a text-only signature would miss.
    entity.cellWidth = 12;
    syncProjection(scene);
    const after = lineElements(scene, entity);

    expect(after[0]).not.toBe(before[0]);
    expect(after[1]).not.toBe(before[1]);
    const advance =
      after[0]!.querySelector<HTMLElement>('[data-vecto-grid-cell]')!.dataset.vectoGridAdvance;
    expect(Number(advance)).toBeCloseTo(12, 5);
  });

  it('rebuilds a line when line height changes', () => {
    const entity = new GridEntity('aaa\nbbb');
    scene.add(entity);
    syncProjection(scene);
    const before = lineElements(scene, entity);

    entity.lineHeight = 24;
    syncProjection(scene);
    const after = lineElements(scene, entity);
    expect(after[0]).not.toBe(before[0]);
    expect(after[0]!.style.height).toBe('24px');
  });

  it('keeps source offsets correct on reused and rebuilt lines alike', () => {
    const entity = new GridEntity('ab\ncd');
    scene.add(entity);
    syncProjection(scene);

    entity.text = 'ab\ncd\nef';
    syncProjection(scene);

    // Walk every carrier and assert its recorded source range still slices the
    // characters it displays. A reuse bug shows up here as an off-by-N that no
    // visual check would catch.
    const el = scene.getContentElement(entity.id) as HTMLElement;
    for (const cell of el.querySelectorAll<HTMLElement>('[data-vecto-grid-cell]')) {
      const start = Number(cell.dataset.vectoGridSourceStart);
      const end = Number(cell.dataset.vectoGridSourceEnd);
      const sourceLength = Number(cell.dataset.vectoGridSourceLength);
      expect(end - start).toBe(sourceLength);
      // textContent may carry a trailing hard break on the last cell of a line.
      expect(cell.textContent!.startsWith(entity.text.slice(start, end))).toBe(true);
    }
  });

  it('preserves the basis markers only on the first line', () => {
    const entity = new GridEntity('aaa\nbbb');
    scene.add(entity);
    syncProjection(scene);
    const lines = lineElements(scene, entity);
    expect(lines[0]!.querySelectorAll('[data-vecto-grid-basis]').length).toBe(3);
    expect(lines[1]!.querySelectorAll('[data-vecto-grid-basis]').length).toBe(0);
  });

  it('reports a carrier count matching the rebuilt DOM', () => {
    const entity = new GridEntity('ab\ncd');
    scene.add(entity);
    syncProjection(scene);
    entity.text = 'ab\ncd\nef';
    syncProjection(scene);

    const el = scene.getContentElement(entity.id) as HTMLElement;
    const actual = el.querySelectorAll('[data-vecto-grid-cell]').length;
    expect(Number(el.dataset.vectoGridCarriers)).toBe(actual);
  });
});

describe('content grid reuse under streaming', () => {
  it('reuses all but the last two lines across many appends', () => {
    const { scene } = makeScene();
    const entity = new GridEntity('line 0');
    scene.add(entity);
    syncProjection(scene);

    let identityPreserved = 0;
    let identityChanged = 0;

    for (let append = 1; append <= 20; append++) {
      const before = lineElements(scene, entity);
      entity.text += `\nline ${append}`;
      syncProjection(scene);
      const after = lineElements(scene, entity);

      for (let i = 0; i < before.length; i++) {
        if (after[i] === before[i]) identityPreserved++;
        else identityChanged++;
      }
    }

    // Each append rebuilds exactly one existing line — the previous last, which
    // acquires a hard break — plus the new one. Everything before it is reused, so
    // the work per append is O(1) in changed lines rather than O(n) in the whole
    // block. That is the property the 8,200-createElement-per-frame storm violated.
    expect(identityChanged).toBe(20);
    expect(identityPreserved).toBe(190);
  });

  it('produces DOM identical to a from-scratch build', () => {
    // The safety net for the whole optimisation: incremental reuse must be
    // indistinguishable from rebuilding everything. Any signature field that is
    // missing would show up here as a difference in the serialized DOM.
    const streamed = makeScene();
    const streamedEntity = new GridEntity('alpha');
    streamed.scene.add(streamedEntity);
    syncProjection(streamed.scene);
    for (const chunk of ['beta', 'gamma', 'delta epsilon', 'zeta']) {
      streamedEntity.text += `\n${chunk}`;
      syncProjection(streamed.scene);
    }

    const fresh = makeScene();
    const freshEntity = new GridEntity('alpha\nbeta\ngamma\ndelta epsilon\nzeta');
    fresh.scene.add(freshEntity);
    syncProjection(fresh.scene);

    const normalize = (scene: Scene, entity: Entity): string => {
      const el = scene.getContentElement(entity.id) as HTMLElement;
      // Strip the per-build signature: it is bookkeeping, not projected semantics.
      return el.innerHTML.replace(/ data-vecto-grid-line-sig="[^"]*"/g, '');
    };

    expect(normalize(streamed.scene, streamedEntity)).toBe(normalize(fresh.scene, freshEntity));
  });
});
