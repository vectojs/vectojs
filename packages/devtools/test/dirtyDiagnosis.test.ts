// @vitest-environment jsdom
// `diagnoseDirty` turns raw attribution counts into a verdict about whether an
// `onDemand` scene can actually idle. The value is in the classification — a
// developer staring at `dirty === true` learns nothing, and a flat list of counts
// still leaves them to work out which rate matters.
import { describe, it, expect, vi } from 'vitest';
import { Scene, Entity } from '@vectojs/core';
import { diagnoseDirty } from '../src/dirtyDiagnosis';

class Box extends Entity {
  constructor(id: string) {
    super(id);
    this.width = 30;
    this.height = 30;
  }
  isPointInside(): boolean {
    return false;
  }
  render(): void {}
}

function makeScene(): Scene {
  (globalThis as { window?: unknown }).window = {
    innerWidth: 300,
    innerHeight: 200,
    devicePixelRatio: 1,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  };
  const ctx = new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === 'measureText') return (t: string) => ({ width: String(t).length * 8 });
        if (prop === 'canvas') return { width: 300, height: 200, style: {} };
        return () => {};
      },
      set: () => true,
    },
  ) as unknown as CanvasRenderingContext2D;
  HTMLCanvasElement.prototype.getContext = (() => ctx) as never;
  const canvas = document.createElement('canvas');
  canvas.width = 300;
  canvas.height = 200;
  const scene = new Scene(canvas, { disableWindowResize: true });
  scene.resize(300, 200);
  return scene;
}

describe('diagnoseDirty', () => {
  it('says tracking is off rather than reporting a false all-clear', () => {
    const scene = makeScene();
    const d = diagnoseDirty(scene);
    // Reporting "no causes" here would read as "your scene is idle", which is the
    // opposite of what an un-instrumented scene actually tells you.
    expect(d.summary).toMatch(/tracking is off/i);
    expect(d.causes).toEqual([]);
    scene.destroy();
  });

  it('flags a cause that fires every frame as continuous redraw', () => {
    const scene = makeScene();
    scene.renderMode = 'onDemand';
    scene.setDirtyTracking(true);

    // One attribution per frame, which is exactly the pattern that defeats
    // onDemand without any visible symptom other than power use.
    for (let i = 0; i < 20; i++) {
      scene.markDirty({ entity: 'answer', reason: 'streaming-text' });
      scene.step(16.67);
    }

    const d = diagnoseDirty(scene);
    expect(d.renderMode).toBe('onDemand');
    expect(d.everyFrame.length).toBeGreaterThan(0);
    expect(d.everyFrame[0]!.entity).toBe('answer');
    expect(d.summary).toMatch(/continuous redraw/i);
    scene.destroy();
  });

  it('reports idling as intended when nothing fires every frame', () => {
    const scene = makeScene();
    scene.renderMode = 'onDemand';
    scene.setDirtyTracking(true);

    // Spread a few marks across a long window. Passing an explicit `frames` is
    // what makes this measurable: an idle onDemand scene stops advancing
    // `currentFrame` precisely because it stops rendering, so the recorded span
    // collapses to the frames it actually drew — a single mark then looks like
    // 1/frame, which is correct but not the question being asked here.
    for (let i = 0; i < 3; i++) scene.markDirty({ entity: 'button', reason: 'hover' });

    const d = diagnoseDirty(scene, { frames: 60 });
    expect(d.everyFrame).toEqual([]);
    expect(d.summary).toMatch(/idling as intended/i);
    scene.destroy();
  });

  it("says renderMode 'always' makes the rest moot", () => {
    const scene = makeScene();
    scene.setDirtyTracking(true);
    scene.markDirty({ entity: 'x', reason: 'moved' });

    const d = diagnoseDirty(scene);
    // Without this, someone profiling an 'always' scene would chase a "cause"
    // that changes nothing, since it redraws regardless.
    expect(d.renderMode).toBe('always');
    expect(d.summary).toMatch(/'always'/);
    scene.destroy();
  });

  it('computes a per-frame rate, which is what distinguishes the culprit', () => {
    const scene = makeScene();
    scene.renderMode = 'onDemand';
    scene.setDirtyTracking(true);

    for (let i = 0; i < 10; i++) {
      scene.markDirty({ entity: 'hot', reason: 'driver-tick' });
      if (i % 5 === 0) scene.markDirty({ entity: 'cold', reason: 'resize' });
      scene.step(16.67);
    }

    const d = diagnoseDirty(scene);
    const hot = d.causes.find((c) => c.entity === 'hot')!;
    const cold = d.causes.find((c) => c.entity === 'cold')!;
    expect(hot.perFrame).toBeGreaterThan(cold.perFrame);
    // Only the every-frame cause is actionable for onDemand.
    expect(d.everyFrame.map((c) => c.entity)).toContain('hot');
    expect(d.everyFrame.map((c) => c.entity)).not.toContain('cold');
    scene.destroy();
  });

  it('attributes a real animation without the developer instrumenting it', () => {
    const scene = makeScene();
    scene.renderMode = 'onDemand';
    const box = new Box('slider-knob');
    scene.add(box);
    scene.setDirtyTracking(true);

    void box.animateTo({ x: 60 }, { duration: 120, easing: 'linear' });
    for (let i = 0; i < 8; i++) scene.step(16.67);

    const d = diagnoseDirty(scene);
    expect(d.causes.length).toBeGreaterThan(0);
    // The engine's own call sites carry attribution, so an animation is
    // identifiable out of the box.
    expect(d.causes.some((c) => c.entity === 'slider-knob')).toBe(true);
    scene.destroy();
  });

  it('limits the reported causes', () => {
    const scene = makeScene();
    scene.setDirtyTracking(true);
    for (let i = 0; i < 25; i++) scene.markDirty({ entity: `e${i}`, reason: 'moved' });

    expect(diagnoseDirty(scene).causes).toHaveLength(10);
    expect(diagnoseDirty(scene, { limit: 3 }).causes).toHaveLength(3);
    scene.destroy();
  });
});
