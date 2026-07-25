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
    // The a11yRoot also holds a focus sentinel (kept last); assert on the
    // entity mirrors only (they carry data-vecto-id).
    const mirrors = () => Array.from(a11yRoot.querySelectorAll<HTMLElement>('[data-vecto-id]'));
    expect(mirrors().length).toBe(3);

    // Strict DFS Preorder: parent -> child1 -> child2
    expect(mirrors()[0].getAttribute('data-vecto-id')).toBe('parent');
    expect(mirrors()[1].getAttribute('data-vecto-id')).toBe('child1');
    expect(mirrors()[2].getAttribute('data-vecto-id')).toBe('child2');

    // Focus sentinel is present and stays after the entity mirrors.
    expect(a11yRoot.children.length).toBe(4);
    expect(a11yRoot.lastElementChild?.hasAttribute('data-vecto-focus-sentinel')).toBe(true);

    // Swap child order
    parent.remove(child1);
    parent.add(child1);

    tick();

    // New DFS Preorder: parent -> child2 -> child1
    expect(mirrors()[0].getAttribute('data-vecto-id')).toBe('parent');
    expect(mirrors()[1].getAttribute('data-vecto-id')).toBe('child2');
    expect(mirrors()[2].getAttribute('data-vecto-id')).toBe('child1');
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

  describe('focus preservation on removal (virtualization/streaming)', () => {
    it('moves focus to the sentinel (not <body>) when the focused mirror is removed', () => {
      const ent = new TestInteractiveEntity('focus-victim');
      scene.add(ent);
      tick();

      const el = (scene as any).a11yElements.get('focus-victim') as HTMLElement;
      el.focus();
      expect(document.activeElement).toBe(el);

      // Remove the focused entity's subtree (what a virtualized row recycle /
      // streamed-away block does).
      scene.remove(ent);
      tick();

      const sentinel = (scene as any).focusSentinel as HTMLElement;
      // Focus landed on the sentinel, still inside the a11y region — NOT body.
      expect(document.activeElement).toBe(sentinel);
      expect(document.activeElement).not.toBe(document.body);
    });

    it('does not steal focus when the removed element was not focused', () => {
      const a = new TestInteractiveEntity('keep-focus');
      const b = new TestInteractiveEntity('remove-me');
      scene.add(a);
      scene.add(b);
      tick();

      const aEl = (scene as any).a11yElements.get('keep-focus') as HTMLElement;
      aEl.focus();
      expect(document.activeElement).toBe(aEl);

      // Removing a DIFFERENT, unfocused entity must not disturb focus.
      scene.remove(b);
      tick();
      expect(document.activeElement).toBe(aEl);
    });
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

  describe('aria-live and related ARIA attributes', () => {
    class LiveRegion extends Entity {
      public attrs: A11yAttributes = { role: 'status' };
      constructor(id: string) {
        super(id);
        this.interactive = true;
        this.width = 200;
        this.height = 40;
      }
      isPointInside() {
        return true;
      }
      render() {}
      getA11yAttributes(): A11yAttributes {
        return this.attrs;
      }
    }

    it('projects aria-live/atomic/relevant onto the shadow element', () => {
      const region = new LiveRegion('live-1');
      region.attrs = {
        role: 'log',
        live: 'polite',
        atomic: true,
        relevant: 'additions text',
      };
      scene.add(region);
      tick();
      const el = (scene as any).a11yElements.get('live-1') as HTMLElement;
      expect(el.getAttribute('aria-live')).toBe('polite');
      expect(el.getAttribute('aria-atomic')).toBe('true');
      expect(el.getAttribute('aria-relevant')).toBe('additions text');
    });

    it('projects labelledby/describedby/required/invalid/level', () => {
      const region = new LiveRegion('field-1');
      region.attrs = {
        role: 'textbox',
        labelledby: 'lbl',
        describedby: 'hint',
        required: true,
        invalid: true,
        level: 2,
      };
      scene.add(region);
      tick();
      const el = (scene as any).a11yElements.get('field-1') as HTMLElement;
      expect(el.getAttribute('aria-labelledby')).toBe('lbl');
      expect(el.getAttribute('aria-describedby')).toBe('hint');
      expect(el.getAttribute('aria-required')).toBe('true');
      expect(el.getAttribute('aria-invalid')).toBe('true');
      expect(el.getAttribute('aria-level')).toBe('2');
    });

    it('removes aria-live when the attribute is cleared', () => {
      const region = new LiveRegion('live-2');
      region.attrs = { role: 'status', live: 'assertive' };
      scene.add(region);
      tick();
      const el = (scene as any).a11yElements.get('live-2') as HTMLElement;
      expect(el.getAttribute('aria-live')).toBe('assertive');

      region.attrs = { role: 'status' }; // drop live
      tick();
      expect(el.hasAttribute('aria-live')).toBe(false);
    });
  });
});
