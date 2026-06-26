// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { Scene } from '../src/tree/Scene';
import { Entity, VectoUIEvent, type A11yAttributes } from '../src/tree/Entity';

/**
 * Stress / load suite: drive the engine at the scale and churn its docs claim it
 * survives (tens of thousands of entities, rapid add/remove, deep nesting, long
 * idle loops) and assert it stays correct and bounded — no throw, no shadow-DOM
 * leak, no per-frame work on a static scene. These are logic-level (jsdom) loads,
 * complementary to the browser FPS benchmark in scripts/benchmark.ts.
 */

/** No-op-everything 2D context (Proxy) so the render loop runs headless. */
function fakeCtx(): CanvasRenderingContext2D {
  return new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === 'measureText') return (t: string) => ({ width: t.length * 8 });
        if (prop === 'createLinearGradient') return () => ({ addColorStop() {} });
        if (prop === 'canvas') return { width: 0, height: 0, style: {} };
        return () => {};
      },
      set: () => true,
    },
  ) as unknown as CanvasRenderingContext2D;
}

function makeScene(): { scene: Scene; host: HTMLElement; tick: (n?: number) => void } {
  const ctx = fakeCtx();
  HTMLCanvasElement.prototype.getContext = (() => ctx) as never;
  const host = document.createElement('div');
  const canvas = document.createElement('canvas');
  host.appendChild(canvas);
  document.body.appendChild(host);
  const scene = new Scene(canvas);
  (scene as unknown as { isRunning: boolean }).isRunning = true; // let loop() run without scheduling
  const tick = (n = 1) => {
    for (let i = 0; i < n; i++) (scene as unknown as { loop: (t: number) => void }).loop(i * 16);
  };
  return { scene, host, tick };
}

/** Counts its own render() calls — lets us assert frame work scales (or not). */
class CountEntity extends Entity {
  renders = 0;
  isPointInside(): boolean {
    return false;
  }
  render(): void {
    this.renders++;
  }
}

/** Interactive entity that projects a real shadow node (button). */
class Box extends Entity {
  constructor() {
    super();
    this.interactive = true;
    this.width = 10;
    this.height = 10;
  }
  isPointInside(): boolean {
    return true;
  }
  render(): void {}
  getA11yAttributes(): A11yAttributes {
    return { tag: 'button', role: 'button' };
  }
}

describe('stress / load', () => {
  it('renders a 50k-entity scene over several frames without throwing', { timeout: 20_000 }, () => {
    const { scene, tick } = makeScene();
    for (let i = 0; i < 50_000; i++) scene.add(new CountEntity().setPosition(i % 800, i % 600));
    expect((scene as unknown as { root: Entity }).root.children.length).toBe(50_000);
    expect(() => tick(5)).not.toThrow();
  });

  it('does not leak accessibility shadow nodes under add/remove churn', { timeout: 20_000 }, () => {
    const { scene, host, tick } = makeScene();
    const a11yEls = (scene as unknown as { a11yElements: Map<string, unknown> }).a11yElements;

    // 6 rounds of: add 250 interactive boxes, sync, then remove them all. The
    // count is held flat each round; a remove() that failed to prune would make
    // a11yElements accumulate across rounds instead. (Counts are modest because
    // each box projects a real jsdom node + listeners — kept brisk on slow CI.)
    for (let round = 0; round < 6; round++) {
      const boxes: Box[] = [];
      for (let i = 0; i < 250; i++) {
        const b = new Box();
        boxes.push(b);
        scene.add(b);
      }
      tick(); // syncA11y projects shadow nodes for the interactive boxes
      expect(a11yEls.size).toBe(250);
      for (const b of boxes) scene.remove(b);
    }

    // After the churn the scene is empty and so is the shadow layer.
    expect((scene as unknown as { root: Entity }).root.children.length).toBe(0);
    expect(a11yEls.size).toBe(0);
    expect(host.querySelectorAll('button').length).toBe(0);
  });

  it('dispatches an event through a 1000-deep tree without stack overflow', () => {
    const { scene, tick } = makeScene();
    let node = new Box();
    const top = node;
    for (let i = 0; i < 1_000; i++) {
      const child = new Box();
      node.add(child);
      node = child;
    }
    const leaf = node;
    scene.add(top);
    tick();

    let captured = 0;
    let bubbled = 0;
    top.on('click', () => captured++, { capture: true });
    top.on('click', () => bubbled++);

    expect(() => leaf.dispatchEvent(new VectoUIEvent('click', leaf))).not.toThrow();
    expect(captured).toBe(1);
    expect(bubbled).toBe(1);
  });

  it('onDemand mode keeps a static scene at zero per-frame render work (cost ⟂ N)', () => {
    const { scene, tick } = makeScene();
    scene.renderMode = 'onDemand';
    const entities: CountEntity[] = [];
    for (let i = 0; i < 1_000; i++) {
      const e = new CountEntity();
      entities.push(e);
      scene.add(e);
    }

    tick(); // dirty is true on first frame → one render pass
    expect(entities[0].renders).toBe(1);

    tick(50); // static + clean → loop early-returns, no further render() calls
    expect(entities[0].renders).toBe(1);

    // A mutation re-arms exactly one more pass.
    scene.markDirty();
    tick();
    expect(entities[0].renders).toBe(2);
  });

  it("'always' mode renders every entity every frame (the contrast to onDemand)", () => {
    const { scene, tick } = makeScene();
    const e = new CountEntity();
    scene.add(e);
    tick(30);
    expect(e.renders).toBe(30);
  });

  it('throttles a11y DOM sync under a long loop when a11ySyncInterval is set', () => {
    const { scene, tick } = makeScene();
    scene.a11ySyncInterval = 100; // ms
    for (let i = 0; i < 500; i++) scene.add(new Box());

    // 60 frames at 16ms each ≈ 960ms of virtual time → ~10 sync windows, not 60.
    const syncs: number[] = [];
    const orig = (scene as unknown as { syncA11y: (n: Entity) => void }).syncA11y.bind(scene);
    const root = (scene as unknown as { root: Entity }).root;
    (scene as unknown as { syncA11y: (n: Entity) => void }).syncA11y = (n: Entity) => {
      if (n === root) syncs.push(1);
      orig(n);
    };

    tick(60);
    expect(syncs.length).toBeGreaterThan(0);
    expect(syncs.length).toBeLessThan(15); // far below the 60 frames
  });

  it('destroy() tears down the shadow layer after a loaded scene', () => {
    const { scene, host, tick } = makeScene();
    for (let i = 0; i < 1_000; i++) scene.add(new Box());
    tick();
    expect(host.querySelectorAll('button').length).toBeGreaterThan(0);

    scene.destroy();
    // destroy() removes the whole a11yRoot container → no shadow buttons remain.
    expect(host.querySelectorAll('button').length).toBe(0);
    expect((scene as unknown as { a11yElements: Map<string, unknown> }).a11yElements.size).toBe(0);
  });
});
