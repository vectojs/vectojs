// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { Scene, Entity } from '../src';

/**
 * Hover is driven by the projected shadow element's `mouseenter`/`mouseleave`.
 * Detaching that element fires no `mouseleave`, so an entity removed WHILE
 * hovered used to keep its hover state forever — visible as soon as it is
 * re-added (a pooled virtualized row, a reopened menu) as hover styling with no
 * pointer anywhere near it. Removal now synthesizes the leave.
 */
class HoverProbe extends Entity {
  public hovered = false;
  public leaves = 0;
  constructor(id: string) {
    super(id);
    this.interactive = true;
    this.width = 50;
    this.height = 20;
    this.on('hover', () => {
      this.hovered = true;
    });
    this.on('pointerleave', () => {
      this.hovered = false;
      this.leaves++;
    });
  }
  isPointInside(): boolean {
    return false;
  }
  render(): void {}
}

function fakeCtx(): CanvasRenderingContext2D {
  return new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === 'measureText') return (t: string) => ({ width: t.length * 8 });
        if (prop === 'canvas') return { width: 0, height: 0, style: {} };
        return () => {};
      },
      set: () => true,
    },
  ) as unknown as CanvasRenderingContext2D;
}

describe('hover is cleared when an entity is removed mid-hover', () => {
  let scene: Scene;

  /** Mount a probe and project its a11y element. */
  const mount = (id = 'p') => {
    const probe = new HoverProbe(id);
    scene.add(probe);
    scene.render((scene as any).renderer, 16, 16);
    (scene as any).syncA11y((scene as any).root);
    const el = (scene as any).a11yElements.get(id) as HTMLElement;
    return { probe, el };
  };

  beforeEach(() => {
    HTMLCanvasElement.prototype.getContext = (() => fakeCtx()) as never;
    const canvas = document.createElement('canvas');
    document.body.appendChild(canvas);
    scene = new Scene(canvas);
  });

  it('dispatches pointerleave when a hovered entity is removed', () => {
    const { probe, el } = mount();
    el.dispatchEvent(new MouseEvent('mouseenter'));
    expect(probe.hovered).toBe(true);

    scene.remove(probe);

    expect(probe.hovered).toBe(false);
    expect(probe.leaves).toBe(1);
  });

  it('does not dispatch a spurious leave when the entity was not hovered', () => {
    const { probe } = mount();
    scene.remove(probe);
    expect(probe.leaves).toBe(0);
  });

  it('does not dispatch a second leave when the pointer already left', () => {
    const { probe, el } = mount();
    el.dispatchEvent(new MouseEvent('mouseenter'));
    el.dispatchEvent(new MouseEvent('mouseleave'));
    expect(probe.leaves).toBe(1);

    scene.remove(probe);
    expect(probe.leaves).toBe(1); // still 1 — no duplicate
  });

  it('clears hover for a hovered child removed with its parent subtree', () => {
    const parent = new HoverProbe('parent');
    const child = new HoverProbe('child');
    parent.add(child);
    scene.add(parent);
    scene.render((scene as any).renderer, 16, 16);
    (scene as any).syncA11y((scene as any).root);

    const childEl = (scene as any).a11yElements.get('child') as HTMLElement;
    childEl.dispatchEvent(new MouseEvent('mouseenter'));
    expect(child.hovered).toBe(true);

    // Removing the PARENT must clear the child's hover too (recursive prune).
    scene.remove(parent);
    expect(child.hovered).toBe(false);
    expect(child.leaves).toBe(1);
  });

  it('leaves a re-added entity in the un-hovered state', () => {
    const { probe, el } = mount();
    el.dispatchEvent(new MouseEvent('mouseenter'));
    scene.remove(probe);

    scene.add(probe);
    scene.render((scene as any).renderer, 16, 16);
    (scene as any).syncA11y((scene as any).root);

    expect(probe.hovered).toBe(false);
  });
});
