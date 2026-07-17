// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Scene, Entity, A11yAttributes } from '../src';

class TestInteractiveEntity extends Entity {
  public customTag: 'div' | 'button' | 'input' = 'div';
  public customRole: string = 'button';
  public customLabel: string = 'Click me';
  public customValue: string = '';

  constructor(id: string) {
    super(id);
    this.interactive = true;
    this.width = 100;
    this.height = 50;
  }

  isPointInside() {
    return true;
  }
  render() {}

  public getA11yAttributes(): A11yAttributes {
    return {
      tag: this.customTag,
      role: this.customRole,
      label: this.customLabel,
      value: this.customValue,
    };
  }
}

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

describe('A11y Root and Agent Contract', () => {
  let canvas: HTMLCanvasElement;
  let scene: Scene;

  const tick = () => {
    (scene as any).isRunning = true;
    (scene as any).loop(0);
  };

  beforeEach(() => {
    const ctx = fakeCtx();
    HTMLCanvasElement.prototype.getContext = (() => ctx) as never;
    canvas = document.createElement('canvas');
    canvas.width = 800;
    canvas.height = 600;
    document.body.appendChild(canvas);
    scene = new Scene(canvas, { maxFPS: 0 });
    scene.renderMode = 'always';
  });

  afterEach(() => {
    scene.destroy();
    canvas.remove();
  });

  it('maintains strict physical order of DOM nodes consistent with DFS preorder traversal', () => {
    const parent = new TestInteractiveEntity('parent');
    const child1 = new TestInteractiveEntity('child1');
    const child2 = new TestInteractiveEntity('child2');

    parent.add(child1);
    parent.add(child2);
    scene.add(parent);

    tick();

    const a11yRoot = (scene as any).a11yRoot as HTMLDivElement;
    expect(a11yRoot.children.length).toBe(3);

    // Strict DFS Preorder: parent -> child1 -> child2
    expect(a11yRoot.children[0].getAttribute('data-vecto-id')).toBe('parent');
    expect(a11yRoot.children[1].getAttribute('data-vecto-id')).toBe('child1');
    expect(a11yRoot.children[2].getAttribute('data-vecto-id')).toBe('child2');

    // Swap child order
    parent.remove(child1);
    parent.add(child1);

    tick();

    // New DFS Preorder: parent -> child2 -> child1
    expect(a11yRoot.children[0].getAttribute('data-vecto-id')).toBe('parent');
    expect(a11yRoot.children[1].getAttribute('data-vecto-id')).toBe('child2');
    expect(a11yRoot.children[2].getAttribute('data-vecto-id')).toBe('child1');
  });

  it('recreates element if tag name changes at runtime', () => {
    const ent = new TestInteractiveEntity('tagchanger');
    scene.add(ent);

    tick();
    const a11yRoot = (scene as any).a11yRoot as HTMLDivElement;
    const initialElement = a11yRoot.children[0];
    expect(initialElement.tagName.toLowerCase()).toBe('div');

    ent.customTag = 'button';
    tick();

    const updatedElement = a11yRoot.children[0];
    expect(updatedElement.tagName.toLowerCase()).toBe('button');
    expect(updatedElement).not.toBe(initialElement);
  });

  it('guards active typing input from cursor resets', () => {
    const ent = new TestInteractiveEntity('text-input');
    ent.customTag = 'input';
    ent.customValue = 'initial';
    scene.add(ent);

    tick();
    const inputEl = (scene as any).a11yElements.get('text-input') as HTMLInputElement;
    expect(inputEl.value).toBe('initial');

    // Simulate user active typing by focusing and writing in the element
    inputEl.focus();
    inputEl.value = 'initial updated';
    inputEl.dispatchEvent(new Event('input'));

    // Trigger frame sync, simulating Vecto state update
    ent.customValue = 'initial updated';
    tick();

    expect(inputEl.value).toBe('initial updated');
  });

  it('clears caret blink timer lifecycle when active inputs are blurred or scene stopped', () => {
    vi.useFakeTimers();
    const ent = new TestInteractiveEntity('input-blink');
    ent.customTag = 'input';
    scene.add(ent);
    scene.start();

    tick();
    const inputEl = (scene as any).a11yElements.get('input-blink') as HTMLInputElement;

    // Verify no timer is active before focus
    expect((scene as any).caretBlinkTimer).toBeNull();

    // Focus triggers caret blink timer on demand
    scene.renderMode = 'onDemand';
    inputEl.focus();
    expect((scene as any).caretBlinkTimer).not.toBeNull();

    // Blur clears the timer
    inputEl.blur();
    expect((scene as any).caretBlinkTimer).toBeNull();

    // Refocus and stop scene clears the timer
    inputEl.focus();
    expect((scene as any).caretBlinkTimer).not.toBeNull();
    scene.stop();
    expect((scene as any).caretBlinkTimer).toBeNull();

    vi.useRealTimers();
  });

  it('getA11yTree returns valid structural WAI-ARIA schema tree representation', () => {
    const parent = new TestInteractiveEntity('parent');
    parent.customRole = 'group';
    const child = new TestInteractiveEntity('child');
    child.customRole = 'button';

    parent.add(child);
    scene.add(parent);
    tick();

    const tree = scene.getA11yTree();
    expect(tree.length).toBe(1);
    expect(tree[0].id).toBe('parent');
    expect(tree[0].role).toBe('group');
    expect(tree[0].children.length).toBe(1);
    expect(tree[0].children[0].id).toBe('child');
    expect(tree[0].children[0].role).toBe('button');
  });

  it('entity.focus() focuses the projected shadow element', () => {
    const entity = new TestInteractiveEntity('focus-me');
    scene.add(entity);
    tick(); // one a11y sync pass

    const spy = vi
      .spyOn(document.getElementById('focus-me')!, 'focus')
      .mockImplementation(() => {});
    entity.focus();
    expect(spy).toHaveBeenCalledExactlyOnceWith();
    spy.mockRestore();
  });
});
