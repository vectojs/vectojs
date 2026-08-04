// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { Entity, Scene } from '../src/index';
import type { ContentProjection } from '../src/tree/Entity';

/**
 * Dirty-tracked content projection sync.
 *
 * `Scene.syncContentProjection` used to call `getContentProjection()` — an
 * O(glyphs-in-block) build — and re-diff the result for every resident block on
 * every synced frame, even when nothing had changed. Measured on a
 * 1500-resident-block document in real headed Chrome: a sync whose
 * `a11yRoot.textContent` was byte-identical before and after still cost
 * 17.875 ms, and the full pass fell from 19.455 ms to 0.475 ms (~41x) once
 * unchanged blocks were skipped ahead of the call. (carryctx CTX-0199,
 * vectojs#343)
 *
 * The optimization is opt-in via `Entity.getContentEpoch()`. These tests pin
 * both directions, and the dangerous one is the second: a skip that should not
 * have happened does not look wrong, it silently serves stale text to
 * find-in-page and screen readers, and stale geometry to selection.
 */
class ProjectingEntity extends Entity {
  public text: string;
  public epoch: number | null = 0;
  /** Every `getContentProjection()` call, to prove a skip really skipped. */
  public projectionCalls = 0;

  constructor(text: string) {
    super();
    this.text = text;
    this.width = 200;
    this.height = 40;
  }

  public override getContentEpoch(): number | null {
    return this.epoch;
  }

  public override getContentProjection(): ContentProjection {
    this.projectionCalls++;
    return {
      text: this.text,
      font: '15px sans-serif',
      lineHeight: 16,
      selectable: true,
    };
  }

  public override isPointInside(): boolean {
    return false;
  }

  public override render(): void {}
}

function makeScene(): Scene {
  // Grid calibration runs in a deferred rAF and measures real text with
  // `Range.getBoundingClientRect`, which jsdom does not implement. None of these
  // entities project a grid, but removing rAF keeps the suite deterministic if
  // one ever does.
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
  const scene = new Scene(canvas, { disableWindowResize: true });
  scene.resize(600, 400);
  return scene;
}

/** Force a full a11y + content projection pass, which `step()` does not do. */
function syncProjection(scene: Scene): void {
  (scene as unknown as { syncA11y: (n: unknown) => void }).syncA11y(
    (scene as unknown as { root: unknown }).root,
  );
}

function projectedText(scene: Scene, entity: Entity): string {
  return scene.getContentElement(entity.id)?.textContent ?? '';
}

describe('content projection dirty tracking', () => {
  let scene: Scene;

  beforeEach(() => {
    scene = makeScene();
  });

  it('skips getContentProjection() entirely when epoch and geometry are unchanged', () => {
    const entity = new ProjectingEntity('hello');
    scene.add(entity);

    syncProjection(scene);
    // The first sync must run in full: there is no DOM node yet to preserve.
    expect(entity.projectionCalls).toBe(1);
    expect(projectedText(scene, entity)).toBe('hello');

    syncProjection(scene);
    syncProjection(scene);
    syncProjection(scene);

    // The whole point. Before dirty tracking this was 4.
    expect(entity.projectionCalls).toBe(1);
    // And the DOM the skip preserved is still correct, not merely present.
    expect(projectedText(scene, entity)).toBe('hello');
  });

  it('rebuilds when the epoch is bumped, and serves the new text', () => {
    const entity = new ProjectingEntity('before');
    scene.add(entity);
    syncProjection(scene);
    expect(entity.projectionCalls).toBe(1);

    entity.text = 'after';
    entity.epoch = 1;
    syncProjection(scene);

    expect(entity.projectionCalls).toBe(2);
    expect(projectedText(scene, entity)).toBe('after');
  });

  it('serves stale text if an entity lies about its epoch (contract is on the implementer)', () => {
    const entity = new ProjectingEntity('original');
    scene.add(entity);
    syncProjection(scene);

    // Content changed but the epoch did not — the documented failure mode.
    entity.text = 'changed';
    syncProjection(scene);

    expect(entity.projectionCalls).toBe(1);
    expect(projectedText(scene, entity)).toBe('original');
  });

  it('never skips for an entity that returns null (default opt-out)', () => {
    const entity = new ProjectingEntity('opted out');
    entity.epoch = null;
    scene.add(entity);

    syncProjection(scene);
    syncProjection(scene);
    syncProjection(scene);

    // Unchanged pre-existing behaviour for every entity that does not opt in.
    expect(entity.projectionCalls).toBe(3);
  });

  it('rebuilds when the entity moves, so the DOM follows the canvas', () => {
    const entity = new ProjectingEntity('moving');
    scene.add(entity);
    syncProjection(scene);
    const el = scene.getContentElement(entity.id) as HTMLElement;
    expect(el.style.top).toBe('0px');

    // Geometry-only change: same content, same epoch.
    entity.y = 25;
    syncProjection(scene);

    expect(entity.projectionCalls).toBe(2);
    expect(el.style.top).toBe('25px');
  });

  it('rebuilds when the entity is resized', () => {
    const entity = new ProjectingEntity('resizing');
    scene.add(entity);
    syncProjection(scene);
    expect(entity.projectionCalls).toBe(1);

    entity.width = 320;
    syncProjection(scene);

    expect(entity.projectionCalls).toBe(2);
    expect((scene.getContentElement(entity.id) as HTMLElement).style.width).toBe('320px');
  });

  it('rebuilds when interactivity changes, so aria-hidden follows', () => {
    const entity = new ProjectingEntity('aria');
    scene.add(entity);
    syncProjection(scene);
    const el = scene.getContentElement(entity.id) as HTMLElement;
    expect(el.getAttribute('aria-hidden')).toBeNull();

    // An interactive entity projects its own a11y node, so the text copy must be
    // hidden or a screen reader announces it twice.
    entity.interactive = true;
    syncProjection(scene);

    expect(entity.projectionCalls).toBe(2);
    expect(el.getAttribute('aria-hidden')).toBe('true');
  });

  it('rebuilds after a font/metric epoch bump, so grid calibration is not starved', () => {
    const entity = new ProjectingEntity('metrics');
    scene.add(entity);
    syncProjection(scene);
    expect(entity.projectionCalls).toBe(1);

    // What `resize()` and the `document.fonts` loadingdone handler both do. It
    // moves nothing and changes no content, but it invalidates every prepared
    // grid's calibration key — so a skip here would leave grid carriers measured
    // against superseded metrics with nothing to trigger a re-measure.
    (scene as unknown as { contentFontEpoch: number }).contentFontEpoch++;
    syncProjection(scene);

    expect(entity.projectionCalls).toBe(2);
  });

  it('re-materializes correctly after the margin gate frees the element', () => {
    const entity = new ProjectingEntity('scrolling');
    scene.add(entity);
    syncProjection(scene);
    expect(scene.getContentElement(entity.id)).toBeDefined();

    // Far outside the default margin (one viewport height): the gate releases the
    // DOM node without the projection being consulted.
    entity.y = 100000;
    syncProjection(scene);
    expect(scene.getContentElement(entity.id)).toBeUndefined();

    // Back in view. The stale state record must not let this be skipped — there
    // is no DOM to preserve, so it has to be rebuilt from scratch.
    entity.y = 0;
    syncProjection(scene);
    expect(scene.getContentElement(entity.id)).toBeDefined();
    expect(projectedText(scene, entity)).toBe('scrolling');
  });

  it('does not leak sync state for a removed entity', () => {
    const entity = new ProjectingEntity('temporary');
    scene.add(entity);
    syncProjection(scene);
    const state = (scene as unknown as { contentSyncState: Map<string, unknown> }).contentSyncState;
    expect(state.has(entity.id)).toBe(true);

    scene.remove(entity);
    expect(state.has(entity.id)).toBe(false);
  });

  it('tracks each entity independently', () => {
    const a = new ProjectingEntity('alpha');
    const b = new ProjectingEntity('beta');
    b.y = 60;
    scene.add(a);
    scene.add(b);
    syncProjection(scene);
    expect(a.projectionCalls).toBe(1);
    expect(b.projectionCalls).toBe(1);

    a.text = 'alpha changed';
    a.epoch = 1;
    syncProjection(scene);

    // Only the changed entity pays. This is what makes a streaming tail block
    // cheap in a long document: one rebuild, not one per resident block.
    expect(a.projectionCalls).toBe(2);
    expect(b.projectionCalls).toBe(1);
    expect(projectedText(scene, a)).toBe('alpha changed');
    expect(projectedText(scene, b)).toBe('beta');
  });
});
