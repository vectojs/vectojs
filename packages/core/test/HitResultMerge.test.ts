// @vitest-environment jsdom
// `findHitsAt` (RFC5 §2, CTX-0600): the canvas spatial test plus
// caller-observed DOM-native candidates merged into ONE ordered candidate
// list. Covers merged ordering (overlay above main-tree), the disabled /
// pointerEvents:'none' predicate on both sides, and scene-space coordinates.
// `findEntityAt` keeps its single topmost answer — no dispatch change.
import { describe, it, expect, vi } from 'vitest';
import { Scene, Entity, type Bounds, type A11yAttributes } from '../src/index';

HTMLCanvasElement.prototype.getContext = (() => null) as never;

/** An axis-aligned rectangle at its local origin; hit == inside its world box. */
class Rect extends Entity {
  public a11y: A11yAttributes = {};
  constructor(
    id: string,
    public width: number,
    public height: number,
  ) {
    super(id);
  }
  getBounds(): Bounds {
    return { x: 0, y: 0, width: this.width, height: this.height };
  }
  isPointInside(gx: number, gy: number): boolean {
    const local = this.worldToLocal(gx, gy);
    if (!local) return false;
    return local.x >= 0 && local.x <= this.width && local.y >= 0 && local.y <= this.height;
  }
  getA11yAttributes(): A11yAttributes {
    return this.a11y;
  }
  render(): void {}
}

function makeScene(): Scene {
  const canvas = document.createElement('canvas');
  return new Scene(canvas, { disableWindowResize: true });
}

describe('findHitsAt — merged HitResult list', () => {
  it('orders overlay-canvas above main-canvas at the same point', () => {
    const scene = makeScene();
    const main = new Rect('main', 100, 100);
    scene.add(main);
    const overlay = new Rect('overlay', 100, 100);
    scene.showOverlay(overlay);

    const hits = scene.findHitsAt(50, 50);
    expect(hits.map((h) => h.node.id)).toEqual(['overlay', 'main']);
    expect(hits.map((h) => h.backend)).toEqual(['canvas', 'canvas']);
    expect(hits[0].priority).toBeGreaterThan(hits[1].priority);
    expect(hits[0].priority).toBe(2);
    expect(hits[1].priority).toBe(0);
  });

  it('merges DOM-native candidates above canvas within one subtree', () => {
    const scene = makeScene();
    const under = new Rect('under', 100, 100);
    scene.add(under);
    const over = new Rect('over', 100, 100);
    scene.add(over); // canvas topmost

    const hits = scene.findHitsAt(50, 50, [{ node: under, backend: 'portal' }]);
    expect(hits.map((h) => h.backend)).toEqual(['portal', 'canvas']);
    expect(hits[0].node.id).toBe('under');
    expect(hits[0].priority).toBe(1);
    expect(hits[1].node.id).toBe('over');
  });

  it("accepts the 'dom-visual' extension point through the same path", () => {
    const scene = makeScene();
    const node = new Rect('dom-node', 100, 100);
    scene.add(node);

    const hits = scene.findHitsAt(50, 50, [{ node, backend: 'dom-visual' }]);
    const dom = hits.find((h) => h.backend === 'dom-visual');
    expect(dom?.node.id).toBe('dom-node');
    expect(dom?.priority).toBe(1);
    expect(dom?.worldPoint).toEqual({ x: 50, y: 50 });
  });

  it('excludes disabled nodes on both the canvas and DOM sides', () => {
    const scene = makeScene();
    const disabledCanvas = new Rect('disabled-canvas', 100, 100);
    disabledCanvas.a11y = { disabled: true };
    scene.add(disabledCanvas);
    const disabledDom = new Rect('disabled-dom', 100, 100);
    disabledDom.a11y = { disabled: true };
    scene.add(disabledDom);
    const eligibleDom = new Rect('eligible-dom', 100, 100);
    scene.add(eligibleDom);

    const hits = scene.findHitsAt(50, 50, [
      { node: disabledDom, backend: 'mirror' },
      { node: eligibleDom, backend: 'mirror' },
    ]);
    const ids = hits.map((h) => h.node.id);
    expect(ids).not.toContain('disabled-canvas');
    expect(ids).not.toContain('disabled-dom');
    expect(ids).toContain('eligible-dom');
  });

  it("excludes pointerEvents:'none' nodes on both sides", () => {
    const scene = makeScene();
    const transparentCanvas = new Rect('transparent-canvas', 100, 100);
    transparentCanvas.a11y = { pointerEvents: 'none' };
    scene.add(transparentCanvas);
    const transparentDom = new Rect('transparent-dom', 100, 100);
    transparentDom.a11y = { pointerEvents: 'none' };
    scene.add(transparentDom);

    const hits = scene.findHitsAt(50, 50, [{ node: transparentDom, backend: 'mirror' }]);
    expect(hits).toEqual([]);
  });

  it('attributes scene-space and node-local coordinates', () => {
    const scene = makeScene();
    const r = new Rect('r', 100, 100);
    r.setPosition(10, 20);
    scene.add(r);

    const hits = scene.findHitsAt(30, 40);
    expect(hits).toHaveLength(1);
    expect(hits[0].worldPoint).toEqual({ x: 30, y: 40 });
    expect(hits[0].localPoint).toEqual({ x: 20, y: 20 });
  });

  it('maps client coordinates through clientToScene', () => {
    const canvas = document.createElement('canvas');
    const scene = new Scene(canvas, { disableWindowResize: true });
    scene.width = 800;
    scene.height = 600;
    vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue({
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: 800,
      bottom: 600,
      width: 800,
      height: 600,
      toJSON: () => {},
    });
    const r = new Rect('r', 100, 100);
    scene.add(r);

    const hits = scene.findHitsAtClient(50, 50);
    expect(hits.map((h) => h.node.id)).toEqual(['r']);
    expect(hits[0].worldPoint).toEqual({ x: 50, y: 50 });
  });

  it('leaves findEntityAt as the single topmost canvas answer', () => {
    const scene = makeScene();
    const main = new Rect('main', 100, 100);
    scene.add(main);
    const overlay = new Rect('overlay', 100, 100);
    scene.showOverlay(overlay);
    const other = new Rect('other', 100, 100);
    scene.add(other);

    // DOM candidates do not change the canvas-only answer.
    expect(scene.findEntityAt(50, 50)?.id).toBe('overlay');
    expect(scene.findHitsAt(50, 50, [{ node: other, backend: 'mirror' }])[0].node.id).toBe(
      'overlay',
    );
  });
});
