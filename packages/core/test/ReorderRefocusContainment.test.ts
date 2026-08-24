// @vitest-environment jsdom
// Reorder refocus must treat "moved SUBTREE contains focus", not "moved
// ELEMENT is focused": moving a composite container deep-blurs whatever held
// focus inside it, and the old exact-equality guard restored focus onto the
// container instead of the originally focused descendant (#698).
import { describe, expect, it, beforeAll } from 'vitest';
import { Entity, Scene, A11yAttributes } from '../src';

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

class RoleEntity extends Entity {
  constructor(
    id: string,
    public role: string,
    public yPos = 0,
  ) {
    super(id);
    this.interactive = true;
    this.width = 100;
    this.height = 30;
    this.y = yPos;
  }
  isPointInside() {
    return false;
  }
  render() {}
  getA11yAttributes(): A11yAttributes {
    return { role: this.role };
  }
}

describe('reorder refocus containment', () => {
  beforeAll(() => {
    HTMLCanvasElement.prototype.getContext = (() => fakeCtx()) as never;
  });

  function makeScene(): { scene: Scene; dispose: () => void } {
    const parent = document.createElement('div');
    const canvas = document.createElement('canvas');
    canvas.width = 800;
    canvas.height = 600;
    parent.appendChild(canvas);
    document.body.appendChild(parent);
    const scene = new Scene(canvas);
    (scene as unknown as { isRunning: boolean }).isRunning = true;
    return {
      scene,
      dispose: () => {
        scene.destroy();
        parent.remove();
      },
    };
  }

  const tick = (scene: Scene) => {
    (scene as unknown as { loop(t: number): void }).loop(0);
  };

  function mirror(scene: Scene, id: string): HTMLElement {
    const el = (scene as unknown as { a11yElements: Map<string, HTMLElement> }).a11yElements.get(
      id,
    );
    expect(el).toBeTruthy();
    return el!;
  }

  it('restores focus to the focused descendant when its container is reordered', () => {
    const { scene, dispose } = makeScene();

    // A flat button sits above; a tablist holding a focused tab sits below.
    const sib = new RoleEntity('sib', 'button', 0);
    const list = new RoleEntity('list', 'tablist', 100);
    const tab1 = new RoleEntity('tab1', 'tab', 100);
    list.add(tab1);
    scene.add(sib);
    scene.add(list);
    tick(scene);

    const tabEl = mirror(scene, 'tab1');
    const listEl = mirror(scene, 'list');
    const sibEl = mirror(scene, 'sib');
    expect(listEl.contains(tabEl)).toBe(true);

    tabEl.focus();
    expect(document.activeElement).toBe(tabEl);

    // Reorder: the tablist now sorts ABOVE the button that precedes it in the
    // DOM. A y write alone does not schedule the pass, so stream a new block
    // too (same trick as ContentSelectionDomOrderMove).
    list.y = -50;
    sib.y = 100;
    scene.add(new RoleEntity('appended', 'button', 500));
    scene.markDirty();
    tick(scene);

    // Precondition: the list really moved ahead of the sibling button —
    // without this the test would pass for the wrong reason.
    const parent = listEl.parentNode!;
    expect(parent).toBe(sibEl.parentNode);
    expect(Array.prototype.indexOf.call(parent.childNodes, listEl)).toBeLessThan(
      Array.prototype.indexOf.call(parent.childNodes, sibEl),
    );

    // ...and focus survived on the DESCENDANT, not the container.
    expect(document.activeElement).toBe(tabEl);

    dispose();
  });
});
