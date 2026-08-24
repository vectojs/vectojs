// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { cssLineBoxBaseline, prepareContentGrid } from '@vectojs/text';
import { Entity, Scene } from '../src/index';
import type { ContentProjection } from '../src/tree/Entity';

/**
 * Carrier reuse across a WINDOW SHIFT (scroll), distinct from the append-reuse
 * pinned by `ContentGridReuse.test.ts`.
 *
 * The per-line signature covers everything that determines a carrier's DOM, but
 * deliberately not the absolute line index — a scrolled window shows different
 * lines in the same DOM slots without changing any line's own subtree. The reuse
 * gate once required `dataset.vectoGridLine` equality too, which turned every
 * scroll into a full-window rebuild of byte-identical carriers. Now a signature
 * match keeps the node and restamps the index plus the one output derived from
 * it (`top`, when no projected line supplies an explicit `y`).
 *
 * Two properties are pinned here:
 *
 * - grid-only projections (no `projection.lines`) whose lines are EMPTY reuse
 *   their carriers across a shift, with index + `top` restamped (empty lines
 *   are the one shape whose signatures agree across slots, because the cell
 *   source offsets that distinguish non-empty lines do not exist);
 * - projections WITH per-line geometry still rebuild on a shift, because each
 *   line's absolute `y` is part of its signature — a carrier must never be
 *   kept under a different line's position.
 */

/** Lines tall enough that the window is always a strict subset. */
const LINE_COUNT = 100;
const LINE_HEIGHT = 16;
const BASELINE = 12;
const FONT = '15px monospace';

class RepeatedLineGrid extends Entity {
  /**
   * Every line is EMPTY, so signatures collide across slots: an empty line
   * carries no cells, and the cell `sourceStart/sourceEnd` offsets that keep
   * non-empty lines' signatures distinct do not exist. Blank rows in real code
   * blocks are exactly this shape — the carriers a scroll used to rebuild.
   */
  public text = '\n'.repeat(LINE_COUNT - 1);
  public y = 0;

  constructor() {
    super();
    this.width = 400;
    this.height = LINE_COUNT * LINE_HEIGHT;
  }

  public override getContentProjection(): ContentProjection {
    const grid = prepareContentGrid(this.text, {
      cellWidth: 8,
      lineHeight: LINE_HEIGHT,
      baseline: BASELINE,
      font: FONT,
      measureCell: () => 8,
    });
    return {
      text: this.text,
      font: FONT,
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

class ProjectedLineGrid extends RepeatedLineGrid {
  public override getContentProjection(): ContentProjection {
    const base = super.getContentProjection();
    // Absolute per-line y: exactly what TextEntity/MSDFTextEntity emit. Each
    // line's signature therefore differs from every other line's.
    const grid = base.grid!;
    const lines = grid.lines.map((_, i) => ({
      text: this.text.split('\n')[i] ?? '',
      x: 0,
      y: i * LINE_HEIGHT,
      baseline: BASELINE,
      font: FONT,
      lineHeight: LINE_HEIGHT,
    }));
    return { ...base, lines } as unknown as ContentProjection;
  }
}

function makeScene(): Scene {
  // Grid calibration runs in a deferred rAF and measures real text through
  // `Range.getBoundingClientRect`, which jsdom does not implement. Removing rAF
  // makes `scheduleContentGridCalibration` a no-op. Same harness as
  // `ContentGridSelectionWindow.test.ts`.
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

function sync(scene: Scene): void {
  (scene as unknown as { syncA11y: (n: unknown) => void }).syncA11y(
    (scene as unknown as { root: unknown }).root,
  );
}

function windowOf(el: HTMLElement): { start: number; end: number } {
  const raw = el.dataset.vectoProjectionWindow;
  if (raw === undefined) throw new Error('expected a gated window');
  const [range] = raw.split('/');
  const [start, end] = range.split('-').map(Number);
  return { start, end };
}

describe('content grid carrier reuse across a window shift', () => {
  let scene: Scene;

  beforeEach(() => {
    scene = makeScene();
  });

  it('reuses repeated-content carriers in place when the window scrolls', () => {
    const entity = new RepeatedLineGrid();
    scene.add(entity);
    entity.y = 0;
    sync(scene);
    const el = scene.getContentElement(entity.id) as HTMLElement;
    expect(windowOf(el).start).toBe(0);

    const before = [...el.children] as HTMLElement[];
    expect(before.length).toBeGreaterThan(1);

    // Scroll so the window start moves well past line 0 while the block stays
    // inside the interaction band (same offset `ContentGridSelectionWindow`
    // uses for the gated direction).
    entity.y = -800;
    sync(scene);

    const { start } = windowOf(el);
    expect(start).toBeGreaterThan(0);

    const after = [...el.children] as HTMLElement[];
    // Translating the block can bring more of it into the band, so the window
    // may grow; only the overlap carries reuse guarantees.
    const overlap = Math.min(before.length, after.length);

    // Each slot is judged against its own occupant. Slot 0 must rebuild: its
    // occupant was line 0, and the basis-marker term makes line 0's signature
    // distinct from the line now shown there.
    expect(after[0]).not.toBe(before[0]);
    expect(after[0]!.dataset.vectoGridLine).toBe(`${start}`);

    // Every other slot held an identical non-first line, so the carrier is
    // kept in place and only re-indexed onto the line it now shows.
    for (let slot = 1; slot < overlap; slot++) {
      const lineIndex = start + slot;
      expect(after[slot]).toBe(before[slot]);
      expect(after[slot]!.dataset.vectoGridLine).toBe(`${lineIndex}`);
      // The restamped `top` must track the line's NEW index (no projected line
      // supplies an explicit y here), not stay frozen at the old one.
      const expectedTop =
        lineIndex * LINE_HEIGHT + BASELINE - cssLineBoxBaseline(FONT, LINE_HEIGHT);
      expect(after[slot]!.style.top).toBe(`${expectedTop}px`);
    }
  });

  it('still rebuilds carriers whose line content actually changed', () => {
    const entity = new RepeatedLineGrid();
    // Unique per-line content: no two signatures agree, so nothing may be
    // reused across a shift even though the gate no longer compares indices.
    entity.text = Array.from({ length: LINE_COUNT }, (_, i) => `line ${i}`).join('\n');
    scene.add(entity);
    entity.y = 0;
    sync(scene);
    const el = scene.getContentElement(entity.id) as HTMLElement;
    const before = [...el.children];

    entity.y = -800;
    sync(scene);

    expect(windowOf(el).start).toBeGreaterThan(0);
    const after = [...el.children];
    const overlap = Math.min(before.length, after.length);
    for (let slot = 0; slot < overlap; slot++) {
      expect(after[slot]).not.toBe(before[slot]);
    }
  });

  it('keeps rebuilding projected-line carriers whose absolute y moved slots', () => {
    const entity = new ProjectedLineGrid();
    scene.add(entity);
    entity.y = 0;
    sync(scene);
    const el = scene.getContentElement(entity.id) as HTMLElement;
    const before = [...el.children];

    entity.y = -800;
    sync(scene);

    const { start, end } = windowOf(el);
    expect(start).toBeGreaterThan(0);
    const after = [...el.children];
    expect(after.length).toBe(end - start);
    // Each line carries its own absolute y in the signature, so a shifted
    // window cannot satisfy any slot with a stale carrier.
    for (let slot = 0; slot < after.length; slot++) {
      if (slot < before.length) expect(after[slot]).not.toBe(before[slot]);
      expect(after[slot]!.dataset.vectoGridLine).toBe(`${start + slot}`);
    }
  });
});
