import { describe, it, expect } from 'vitest';
import { Overlay } from '../src/Overlay';

class TestOverlay extends Overlay {
  render(): void {}
}

describe('Overlay animation', () => {
  it('drives opacity through a driver, not the hand-rolled *=0.18 lerp', () => {
    const o = new TestOverlay({ width: 120, height: 80 });
    (o as unknown as { _scene: unknown })._scene = {
      markDirty() {},
      prefersReducedMotion: false,
      _registerActiveDriverEntity() {},
    };
    // Override the constructor's opacity transition with a deterministic tween.
    o.setTransition({ opacity: { duration: 100, easing: 'linear' } });
    o.opacity = 1;
    expect(o.opacity).toBe(0); // not applied instantly — animating
    o.update(50, 50);
    expect(o.opacity).toBeCloseTo(0.5, 6);
    // The old hand-rolled lerp fields are gone.
    expect((o as unknown as { _targetOpacity?: unknown })._targetOpacity).toBeUndefined();
  });
});
