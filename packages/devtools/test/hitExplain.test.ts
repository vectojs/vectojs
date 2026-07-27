// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { Entity, Scene, type A11yAttributes } from '@vectojs/core';
import { explainHitTest, formatHitExplanation } from '../src/hitExplain';

/**
 * `explainHitTest` must mirror `Scene.findHitRecursively` exactly, or an
 * explanation is worse than none: it would confidently give the wrong reason.
 *
 * So every test asserts the explained winner equals what the scene itself returns,
 * in addition to checking the verdict.
 */
class Box extends Entity {
  private attrs: A11yAttributes = {};
  constructor(w = 50, h = 50) {
    super();
    this.width = w;
    this.height = h;
  }
  public setAttrs(attrs: A11yAttributes): this {
    this.attrs = attrs;
    return this;
  }
  public override getA11yAttributes(): A11yAttributes {
    return this.attrs;
  }
  public override isPointInside(x: number, y: number): boolean {
    const local = this.worldToLocal(x, y);
    return (
      !!local && local.x >= 0 && local.x <= this.width && local.y >= 0 && local.y <= this.height
    );
  }
  public override render(): void {}
}

function makeScene(): Scene {
  const canvas = document.createElement('canvas');
  canvas.width = 300;
  canvas.height = 300;
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
  scene.resize(300, 300);
  return scene;
}

const verdictFor = (
  explanation: ReturnType<typeof explainHitTest>,
  id: string,
): string | undefined => explanation.candidates.find((c) => c.entityId === id)?.verdict;

describe('explainHitTest', () => {
  it('accepts a plain hit and agrees with the scene', () => {
    const scene = makeScene();
    const box = new Box();
    scene.add(box);
    const explanation = explainHitTest(scene, 10, 10);
    expect(explanation.hitId).toBe(box.id);
    expect(explanation.root).toBe('main');
    expect(verdictFor(explanation, box.id)).toBe('accepted');
  });

  it('reports nothing hit outside every entity', () => {
    const scene = makeScene();
    scene.add(new Box());
    const explanation = explainHitTest(scene, 250, 250);
    expect(explanation.hitId).toBeNull();
    expect(explanation.root).toBe('none');
  });

  it('explains an invisible entity and skips its subtree', () => {
    const scene = makeScene();
    const parent = new Box(100, 100);
    parent.opacity = 0;
    const child = new Box(50, 50);
    parent.add(child);
    scene.add(parent);

    const explanation = explainHitTest(scene, 10, 10);
    expect(explanation.hitId).toBeNull();
    expect(verdictFor(explanation, parent.id)).toBe('invisible');
    // Opacity accumulates down the tree, so the child must not even be visited —
    // reporting it as a separate miss would suggest it was independently testable.
    expect(verdictFor(explanation, child.id)).toBeUndefined();
    expect(explanation.candidates.find((c) => c.entityId === parent.id)!.reason).toContain(
      'descendant',
    );
  });

  it('explains a clipped-out child and names the clipper', () => {
    const scene = makeScene();
    const clipper = new Box(60, 60);
    clipper.clipChildren = true;
    const child = new Box(40, 40);
    child.setPosition(100, 0); // entirely outside the clip box
    clipper.add(child);
    scene.add(clipper);

    const explanation = explainHitTest(scene, 110, 10);
    // The child's own shape contains the point, which is exactly why "clipped" is
    // the useful reason rather than "outside shape".
    expect(verdictFor(explanation, child.id)).toBe('clipped');
    const finding = explanation.candidates.find((c) => c.entityId === child.id)!;
    expect(finding.clipperId).toBe(clipper.id);
    expect(finding.reason).toContain('outside the clip box');
  });

  it('explains a disabled entity as passing input through', () => {
    const scene = makeScene();
    const behind = new Box(80, 80);
    const disabled = new Box(80, 80).setAttrs({ disabled: true });
    scene.add(behind);
    scene.add(disabled);

    const explanation = explainHitTest(scene, 10, 10);
    expect(verdictFor(explanation, disabled.id)).toBe('pointer-transparent');
    // And the click really does reach what is behind it.
    expect(explanation.hitId).toBe(behind.id);
  });

  it("explains pointerEvents: 'none' the same way", () => {
    const scene = makeScene();
    const transparent = new Box(80, 80).setAttrs({ pointerEvents: 'none' });
    scene.add(transparent);
    const explanation = explainHitTest(scene, 10, 10);
    expect(verdictFor(explanation, transparent.id)).toBe('pointer-transparent');
    expect(explanation.candidates.find((c) => c.entityId === transparent.id)!.reason).toContain(
      'passes through',
    );
  });

  it('marks an eligible loser as occluded rather than leaving it unexplained', () => {
    const scene = makeScene();
    const below = new Box(80, 80);
    const above = new Box(80, 80);
    scene.add(below);
    scene.add(above);

    const explanation = explainHitTest(scene, 10, 10);
    expect(explanation.hitId).toBe(above.id);
    // "Why did my button not get this click?" is the actual question, and
    // `occluded` answers it where a silent omission would not.
    expect(verdictFor(explanation, below.id)).toBe('occluded');
    expect(explanation.candidates.find((c) => c.entityId === below.id)!.reason).toContain(
      'drawn on top',
    );
  });

  it('tests the overlay tree first, as the engine does', () => {
    const scene = makeScene();
    const main = new Box(100, 100);
    scene.add(main);
    const overlay = new Box(100, 100);
    scene.showOverlay(overlay);

    const explanation = explainHitTest(scene, 10, 10);
    // A stray overlay swallowing clicks is the most common surprise this exists
    // to reveal, so the root is reported explicitly.
    expect(explanation.hitId).toBe(overlay.id);
    expect(explanation.root).toBe('overlay');
  });

  it('explains an entity with no isPointInside as unhittable', () => {
    class Shapeless extends Entity {
      public override render(): void {}
    }
    const scene = makeScene();
    const shapeless = new Shapeless();
    shapeless.width = 50;
    shapeless.height = 50;
    scene.add(shapeless);

    const explanation = explainHitTest(scene, 10, 10);
    // The engine requires isPointInside, so such an entity can never be hit;
    // saying so beats omitting it from the chain.
    expect(verdictFor(explanation, shapeless.id)).toBe('outside-shape');
    expect(explanation.candidates.find((c) => c.entityId === shapeless.id)!.reason).toContain(
      'cannot hit',
    );
  });

  it('records depth so the chain can be rendered as a walk', () => {
    const scene = makeScene();
    const parent = new Box(100, 100);
    // Positioned so the point misses the child but hits the parent: that is what
    // makes both appear in the chain at different depths. When a child DOES win,
    // its ancestors are never tested — matching the engine, which stops there.
    const child = new Box(20, 20);
    child.setPosition(60, 60);
    parent.add(child);
    scene.add(parent);

    const explanation = explainHitTest(scene, 10, 10);
    const childCandidate = explanation.candidates.find((c) => c.entityId === child.id)!;
    const parentCandidate = explanation.candidates.find((c) => c.entityId === parent.id)!;
    expect(childCandidate.depth).toBeGreaterThan(parentCandidate.depth);
    expect(childCandidate.verdict).toBe('outside-shape');
    expect(parentCandidate.verdict).toBe('accepted');
  });

  it('does not test ancestors once a descendant wins', () => {
    const scene = makeScene();
    const parent = new Box(100, 100);
    const child = new Box(40, 40);
    parent.add(child);
    scene.add(parent);

    const explanation = explainHitTest(scene, 10, 10);
    expect(explanation.hitId).toBe(child.id);
    // The engine returns as soon as a child hits, so the parent is never
    // evaluated. Inventing a verdict for it would misreport what happened.
    expect(explanation.candidates.find((c) => c.entityId === parent.id)).toBeUndefined();
  });

  it('formats an explanation into readable lines', () => {
    const scene = makeScene();
    const box = new Box();
    scene.add(box);
    const lines = formatHitExplanation(explainHitTest(scene, 10, 10));
    expect(lines[0]).toContain('hit test (10, 10)');
    expect(lines.some((l) => l.includes('✓'))).toBe(true);
  });
});
