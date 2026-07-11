import { describe, it, expect } from 'vitest';
import { UIComponent, type MotionSpec } from '../src/UIComponent';

class Panel extends UIComponent {
  constructor(spec?: { enter?: MotionSpec; exit?: MotionSpec }) {
    super('panel');
    this.width = 100;
    this.height = 100;
    if (spec?.enter) this.enterMotion = spec.enter;
    if (spec?.exit) this.exitMotion = spec.exit;
  }
  render(): void {}
}

// A minimal live-scene stand-in for the pieces add()/the drivers touch.
function liveParent(): Panel {
  const root = new Panel();
  (root as unknown as { _scene: unknown })._scene = {
    markDirty() {},
    detachA11y() {},
    a11yNeedsReorder: false,
    prefersReducedMotion: false,
  };
  return root;
}

describe('UIComponent presence', () => {
  it('plays the enter motion from `from` to `to` on mount', () => {
    const root = liveParent();
    const p = new Panel({
      enter: { props: { opacity: [0, 1] }, config: { duration: 100, easing: 'linear' } },
    });
    root.add(p);
    expect(p.opacity).toBe(0); // seeded to `from`
    p.update(50, 50);
    expect(p.opacity).toBeCloseTo(0.5, 6);
  });

  it('dismiss() keeps the entity parented until exit finishes, then removes it', async () => {
    const root = liveParent();
    const p = new Panel({
      exit: { props: { opacity: [1, 0] }, config: { duration: 100, easing: 'linear' } },
    });
    root.add(p);
    const done = p.dismiss();
    expect(p.parent).toBe(root); // still mounted mid-exit
    for (let i = 0; i < 20 && p.parent; i++) p.update(16, i * 16);
    await done;
    expect(p.parent).toBeNull(); // removed only after exit resolved
  });
});
