// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { prepareContentGrid } from '@vectojs/text';
import { Entity, Scene } from '../src/index';
import type { ContentProjection } from '../src/tree/Entity';

/**
 * Promotion from the coarse (resident) tier to the fine (carrier) grid tier.
 *
 * The two tiers build incompatible DOM for the same block: coarse writes the
 * whole string as one TEXT node (`el.textContent = projection.text`), fine
 * builds one `<span>` per line with one per glyph cluster inside it. The grid
 * path cannot open with `replaceChildren()` — reusing unchanged carrier lines is
 * what keeps streaming affordable — so it addresses carriers through
 * `el.children` and trims the tail with `lastElementChild`. Both are
 * element-only views, which makes the inherited coarse text node invisible to
 * that whole function.
 *
 * These tests pin that a promoted block holds its text exactly ONCE. The failure
 * is silent: nothing looks wrong on the canvas, but find-in-page matches an
 * orphan at stale geometry and a screen reader reads the block twice.
 */
class GridEntity extends Entity {
  public text: string;

  constructor(text: string) {
    super();
    this.text = text;
    this.width = 400;
    this.height = 200;
  }

  public override getContentProjection(): ContentProjection {
    const grid = prepareContentGrid(this.text, {
      cellWidth: 8,
      lineHeight: 16,
      baseline: 12,
      font: '15px monospace',
      measureCell: () => 8,
    });
    return {
      text: this.text,
      font: '15px monospace',
      lineHeight: 16,
      grid,
      selectable: true,
    } as ContentProjection;
  }

  public override getBounds() {
    return { x: 0, y: 0, width: 400, height: 200 };
  }

  public override render(): void {}
}

/**
 * A scene configured for the resident tier: an infinite SEMANTIC margin (every
 * block keeps projected DOM) with a finite INTERACTION margin (only blocks near
 * the viewport get carriers). That split is what makes a coarse tier reachable
 * at all — with both margins equal, a block is either fine-tiered or has no DOM.
 */
function makeScene(): Scene {
  // Calibration runs in a deferred rAF and measures real text with
  // `Range.getBoundingClientRect`, which jsdom does not implement — it would
  // throw after the test finished. Removing rAF makes
  // `scheduleContentGridCalibration` a no-op, isolating promotion, which is what
  // is under test. Calibration is covered by `e2e/text-projection.e2e.ts`.
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
  const scene = new Scene(canvas, {
    disableWindowResize: true,
    contentSemanticMargin: Infinity,
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

/** Direct text-node children of `el` — the ones the grid path used to strand. */
function directTextNodes(el: HTMLElement): Text[] {
  return [...el.childNodes].filter((n): n is Text => n.nodeType === 3);
}

const SOURCE = 'hello world\nsecond line\nthird line here';

/** Park the entity far below the viewport (coarse), then bring it back (fine). */
function coarseThenFine(scene: Scene, entity: GridEntity): HTMLElement {
  entity.y = 100000;
  sync(scene);
  entity.y = 0;
  sync(scene);
  return scene.getContentElement(entity.id) as HTMLElement;
}

describe('content grid promotion from the coarse tier', () => {
  it('projects the coarse tier as a single text node with no carriers', () => {
    const scene = makeScene();
    const entity = new GridEntity(SOURCE);
    scene.add(entity);

    entity.y = 100000; // outside the interaction margin, inside the semantic one
    sync(scene);

    const el = scene.getContentElement(entity.id) as HTMLElement;
    expect(el).not.toBeNull();
    expect(el.childElementCount).toBe(0);
    expect(directTextNodes(el)).toHaveLength(1);
    expect(el.textContent).toBe(SOURCE);
    expect(el.dataset.vectoContentGrid).toBeUndefined();
  });

  it('holds the text exactly once after promotion to the carrier tier', () => {
    const scene = makeScene();
    const entity = new GridEntity(SOURCE);
    scene.add(entity);

    const el = coarseThenFine(scene, entity);

    // The regression: the inherited coarse text node survived alongside the new
    // carriers, so textContent read the block twice (78 chars for 39).
    expect(el.textContent).toBe(SOURCE);
    expect(el.textContent?.length).toBe(SOURCE.length);
    expect(directTextNodes(el)).toHaveLength(0);
  });

  it('builds real carriers during that promotion', () => {
    const scene = makeScene();
    const entity = new GridEntity(SOURCE);
    scene.add(entity);

    const el = coarseThenFine(scene, entity);

    // Guards the assertion above from passing for the wrong reason: stripping the
    // text node while building nothing would also leave textContent correct only
    // if carriers exist to hold it.
    expect(el.dataset.vectoContentGrid).toBeDefined();
    expect(el.childElementCount).toBe(3); // one carrier line per source line
    expect(el.querySelectorAll('[data-vecto-grid-cell]').length).toBeGreaterThan(0);
  });

  it('survives a full coarse → fine → coarse → fine cycle', () => {
    const scene = makeScene();
    const entity = new GridEntity(SOURCE);
    scene.add(entity);

    coarseThenFine(scene, entity);
    // Demote: the coarse branch replaces the carriers with one text node again.
    entity.y = 100000;
    sync(scene);
    const demoted = scene.getContentElement(entity.id) as HTMLElement;
    expect(demoted.textContent).toBe(SOURCE);
    expect(demoted.childElementCount).toBe(0);

    // Promote a second time — the path that would re-strand a text node.
    entity.y = 0;
    sync(scene);
    const repromoted = scene.getContentElement(entity.id) as HTMLElement;
    expect(repromoted.textContent).toBe(SOURCE);
    expect(directTextNodes(repromoted)).toHaveLength(0);
  });

  it('leaves a block that was never coarse untouched', () => {
    const scene = makeScene();
    const entity = new GridEntity(SOURCE);
    scene.add(entity);

    // Straight to the fine tier: no inherited text node to strip, so the strip
    // must be a no-op rather than something that disturbs a healthy build.
    entity.y = 0;
    sync(scene);

    const el = scene.getContentElement(entity.id) as HTMLElement;
    expect(el.textContent).toBe(SOURCE);
    expect(directTextNodes(el)).toHaveLength(0);
    expect(el.childElementCount).toBe(3);
  });
});
