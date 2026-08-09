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

  describe('projection gate transitions', () => {
    // The gate `interactive && (width > 0 || a11yFullViewport)` decides
    // projection, and nothing pinned what happens when an entity stops
    // satisfying it. `syncA11y` only creates and updates, which reads like a
    // leak — but it is always followed by `enforceA11yDomOrder`, whose prune
    // pass removes elements whose entity no longer qualifies. These tests pin
    // that the gate is symmetric in the real frame path, so the planned
    // `a11yProjection` modes have a defined baseline to change.
    it('removes the element when interactive flips to false', () => {
      const e = new TestInteractiveEntity('toggle');
      scene.add(e);
      tick();
      expect(scene.a11yElements.size).toBe(1);
      expect(scene.getA11yElement('toggle')).toBeTruthy();

      e.interactive = false;
      tick();
      expect(scene.a11yElements.size).toBe(0);
      expect(scene.getA11yElement('toggle')).toBeUndefined();
      expect(document.querySelector('[data-vecto-id="toggle"]')).toBeNull();
    });

    it('re-projects when interactive flips back to true', () => {
      const e = new TestInteractiveEntity('recycle');
      scene.add(e);
      tick();
      e.interactive = false;
      tick();
      expect(scene.a11yElements.size).toBe(0);

      e.interactive = true;
      tick();
      expect(scene.a11yElements.size).toBe(1);
      expect(scene.getA11yElement('recycle')).toBeTruthy();
    });

    it('removes the element when the box collapses to zero width', () => {
      const e = new TestInteractiveEntity('shrink');
      scene.add(e);
      tick();
      expect(scene.a11yElements.size).toBe(1);

      // A zero-size element is unfocusable and unhittable, so the gate treats
      // it as not projectable.
      e.width = 0;
      tick();
      expect(scene.a11yElements.size).toBe(0);

      e.width = 100;
      tick();
      expect(scene.a11yElements.size).toBe(1);
    });

    it('keeps projecting a zero-width entity when a11yFullViewport is set', () => {
      const e = new TestInteractiveEntity('boundless');
      e.width = 0;
      e.a11yFullViewport = true;
      scene.add(e);
      tick();
      expect(scene.a11yElements.size).toBe(1);

      // Clearing the exception makes it fail the gate, since width is still 0.
      e.a11yFullViewport = false;
      tick();
      expect(scene.a11yElements.size).toBe(0);
    });

    it('moves focus to the sentinel when the focused element fails the gate', () => {
      const e = new TestInteractiveEntity('focused');
      scene.add(e);
      tick();
      const el = scene.getA11yElement('focused')!;
      el.focus();
      expect(document.activeElement).toBe(el);

      // Pruning a focused element must not drop focus to <body>, or keyboard
      // position is lost entirely.
      e.interactive = false;
      tick();
      expect(scene.a11yElements.size).toBe(0);
      expect(document.activeElement).not.toBe(document.body);
      expect(
        (document.activeElement as HTMLElement)?.hasAttribute('data-vecto-focus-sentinel'),
      ).toBe(true);
    });

    it('keeps focus on a mirror that the ordering pass moves', () => {
      // Two entities whose visual order is the reverse of their insertion order,
      // so the ordering pass must actually move one of them.
      const first = new TestInteractiveEntity('lower');
      first.y = 200;
      const second = new TestInteractiveEntity('upper');
      second.y = 0;
      scene.add(first);
      scene.add(second);
      tick();

      const el = scene.getA11yElement('lower')!;
      el.focus();
      expect(document.activeElement).toBe(el);

      // Force the pass to run again and reposition the focused mirror. Moving a
      // focused element with `insertBefore` blanks `document.activeElement`,
      // which silently disables any component whose keyboard contract rides an
      // entity `keydown` listener — `Dropdown`'s Escape-to-close died this way.
      first.y = -100;
      scene.a11yNeedsReorder = true;
      tick();

      expect(document.activeElement).toBe(el);
    });
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

  describe('tab order follows visual reading order, not scene-graph order', () => {
    const idsInOrder = () =>
      Array.from(
        ((scene as any).a11yRoot as HTMLElement).querySelectorAll<HTMLElement>('[data-vecto-id]'),
      ).map((el) => el.getAttribute('data-vecto-id'));

    it('orders siblings top-to-bottom then left-to-right regardless of add order', () => {
      // Added out of visual order: bottom-right first, then top-right, top-left.
      const br = new TestInteractiveEntity('bottom-right');
      br.x = 200;
      br.y = 200;
      const tr = new TestInteractiveEntity('top-right');
      tr.x = 200;
      tr.y = 0;
      const tl = new TestInteractiveEntity('top-left');
      tl.x = 0;
      tl.y = 0;
      scene.add(br);
      scene.add(tr);
      scene.add(tl);

      tick();

      // Reading order (LTR): (0,0) → (200,0) → (200,200).
      expect(idsInOrder()).toEqual(['top-left', 'top-right', 'bottom-right']);
    });

    it('reverses the inline order within a row under readingDirection="rtl"', () => {
      scene.readingDirection = 'rtl';
      const left = new TestInteractiveEntity('left');
      left.x = 0;
      left.y = 0;
      const right = new TestInteractiveEntity('right');
      right.x = 300;
      right.y = 0;
      scene.add(left);
      scene.add(right);

      tick();

      // Same row → RTL tabs right-to-left.
      expect(idsInOrder()).toEqual(['right', 'left']);
    });

    it('keeps scene-graph order as a stable tiebreak at the same position', () => {
      const a = new TestInteractiveEntity('a');
      const b = new TestInteractiveEntity('b');
      const c = new TestInteractiveEntity('c');
      // All at (0,0): no visual signal to sort by → preserve add order.
      scene.add(a);
      scene.add(b);
      scene.add(c);

      tick();

      expect(idsInOrder()).toEqual(['a', 'b', 'c']);
    });

    it('keeps each clipping region contiguous instead of interleaving them by y', () => {
      // Reproduces the reported defect: dragging a selection through the body
      // column also selected the sidebar, because a DOM Selection covers
      // everything between anchor and focus in DOM order and the two columns
      // were spliced together by row band.
      //
      // Geometry measured from the gallery: sidebar at x=20, body at x=312,
      // and the two columns interleave in y.
      const sidebar = new TestInteractiveEntity('sidebar');
      sidebar.x = 20;
      sidebar.y = 0;
      sidebar.width = 280;
      sidebar.height = 600;
      sidebar.clipChildren = true;
      sidebar.interactive = false;

      const body = new TestInteractiveEntity('body');
      body.x = 312;
      body.y = 0;
      body.width = 900;
      body.height = 600;
      body.clipChildren = true;
      body.interactive = false;

      // Sidebar headings at y=100 and y=300.
      const creations = new TestInteractiveEntity('sidebar-creations');
      creations.x = 0;
      creations.y = 100;
      const builtOn = new TestInteractiveEntity('sidebar-built-on');
      builtOn.x = 0;
      builtOn.y = 300;
      sidebar.add(creations);
      sidebar.add(builtOn);

      // Body paragraphs straddling both sidebar headings in y.
      const p1 = new TestInteractiveEntity('body-p1');
      p1.x = 0;
      p1.y = 50;
      const p2 = new TestInteractiveEntity('body-p2');
      p2.x = 0;
      p2.y = 200;
      const p3 = new TestInteractiveEntity('body-p3');
      p3.x = 0;
      p3.y = 400;
      body.add(p1);
      body.add(p2);
      body.add(p3);

      scene.add(sidebar);
      scene.add(body);

      tick();

      const ids = idsInOrder();
      const sidebarIdx = ids
        .map((id, i) => ({ id, i }))
        .filter((e) => e.id?.startsWith('sidebar-'))
        .map((e) => e.i);
      const bodyIdx = ids
        .map((id, i) => ({ id, i }))
        .filter((e) => e.id?.startsWith('body-'))
        .map((e) => e.i);

      // Each region must occupy one contiguous run of DOM positions. A
      // Selection anchored inside a run therefore cannot reach the other
      // region without passing its boundary.
      const contiguous = (idx: number[]) => idx.every((v, k) => k === 0 || v === idx[k - 1] + 1);
      expect(contiguous(sidebarIdx)).toBe(true);
      expect(contiguous(bodyIdx)).toBe(true);

      // And reading order within a region is still visual top-to-bottom.
      expect(ids.filter((id) => id?.startsWith('body-'))).toEqual([
        'body-p1',
        'body-p2',
        'body-p3',
      ]);
      expect(ids.filter((id) => id?.startsWith('sidebar-'))).toEqual([
        'sidebar-creations',
        'sidebar-built-on',
      ]);
    });

    it('groups a column into its own region from a11yRegion, with no clipping', () => {
      // Same geometry as the clipping case above, but the sidebar declares the
      // grouping instead of buying a per-frame save/clip/restore for an entity
      // that paints nothing. Before `a11yRegion` existed a real app had to set
      // `clipChildren` purely to escape the body column's row bands.
      const sidebar = new TestInteractiveEntity('sidebar');
      sidebar.x = 20;
      sidebar.y = 0;
      sidebar.width = 280;
      sidebar.height = 600;
      sidebar.a11yRegion = true;
      sidebar.interactive = false;

      const body = new TestInteractiveEntity('body');
      body.x = 312;
      body.y = 0;
      body.width = 900;
      body.height = 600;
      body.a11yRegion = true;
      body.interactive = false;

      const creations = new TestInteractiveEntity('sidebar-creations');
      creations.x = 0;
      creations.y = 100;
      const builtOn = new TestInteractiveEntity('sidebar-built-on');
      builtOn.x = 0;
      builtOn.y = 300;
      sidebar.add(creations);
      sidebar.add(builtOn);

      // Body paragraphs straddling both sidebar headings in y, so a single
      // global banding would splice the two columns together.
      const p1 = new TestInteractiveEntity('body-p1');
      p1.x = 0;
      p1.y = 50;
      const p2 = new TestInteractiveEntity('body-p2');
      p2.x = 0;
      p2.y = 200;
      const p3 = new TestInteractiveEntity('body-p3');
      p3.x = 0;
      p3.y = 400;
      body.add(p1);
      body.add(p2);
      body.add(p3);

      scene.add(sidebar);
      scene.add(body);

      tick();

      const ids = idsInOrder();
      const runOf = (prefix: string) =>
        ids
          .map((id, i) => ({ id, i }))
          .filter((e) => e.id?.startsWith(prefix))
          .map((e) => e.i);
      const contiguous = (idx: number[]) => idx.every((v, k) => k === 0 || v === idx[k - 1] + 1);

      expect(contiguous(runOf('sidebar-'))).toBe(true);
      expect(contiguous(runOf('body-'))).toBe(true);

      // Grouping must not disturb reading order inside a region.
      expect(ids.filter((id) => id?.startsWith('body-'))).toEqual([
        'body-p1',
        'body-p2',
        'body-p3',
      ]);
      expect(ids.filter((id) => id?.startsWith('sidebar-'))).toEqual([
        'sidebar-creations',
        'sidebar-built-on',
      ]);

      // The whole point of the flag: no clipping was bought to get the grouping.
      expect(sidebar.clipChildren).toBe(false);
      expect(body.clipChildren).toBe(false);
    });

    it('honours a11yRegion on a zero-area container, unlike clipChildren', () => {
      // A pure grouping container commonly draws nothing and never sets a box.
      // `clipChildren` is exempted at zero area because a zero-area clipper
      // clips nothing; `a11yRegion` is a declaration of intent, so gating it on
      // geometry would ignore exactly the entity it exists for.
      const makeColumn = (name: string, x: number, useClip: boolean) => {
        const col = new TestInteractiveEntity(name);
        col.x = x;
        col.y = 0;
        col.width = 0;
        col.height = 0;
        col.interactive = false;
        if (useClip) col.clipChildren = true;
        else col.a11yRegion = true;
        return col;
      };

      // Zero-area clipper: no region, so the two columns interleave by row.
      const clipLeft = makeColumn('clip-left', 20, true);
      const clipRight = makeColumn('clip-right', 400, true);
      for (const [owner, prefix, ys] of [
        [clipLeft, 'clipL', [100, 300]],
        [clipRight, 'clipR', [50, 200]],
      ] as const) {
        ys.forEach((y, k) => {
          const child = new TestInteractiveEntity(`${prefix}-${k}`);
          child.x = 0;
          child.y = y;
          owner.add(child);
        });
      }
      scene.add(clipLeft);
      scene.add(clipRight);

      tick();

      const clipIds = idsInOrder();
      const clipLeftRun = clipIds
        .map((id, i) => ({ id, i }))
        .filter((e) => e.id?.startsWith('clipL-'))
        .map((e) => e.i);
      const contiguous = (idx: number[]) => idx.every((v, k) => k === 0 || v === idx[k - 1] + 1);
      // Documents the existing zero-area clipping exemption rather than
      // asserting it is desirable: the columns are spliced together.
      expect(contiguous(clipLeftRun)).toBe(false);

      clipLeft.destroy();
      clipRight.destroy();
      scene.remove(clipLeft);
      scene.remove(clipRight);

      // Same zero-area boxes, grouping declared instead: regions hold.
      const regionLeft = makeColumn('region-left', 20, false);
      const regionRight = makeColumn('region-right', 400, false);
      for (const [owner, prefix, ys] of [
        [regionLeft, 'regionL', [100, 300]],
        [regionRight, 'regionR', [50, 200]],
      ] as const) {
        ys.forEach((y, k) => {
          const child = new TestInteractiveEntity(`${prefix}-${k}`);
          child.x = 0;
          child.y = y;
          owner.add(child);
        });
      }
      scene.add(regionLeft);
      scene.add(regionRight);

      tick();

      const regionIds = idsInOrder();
      const runOf = (prefix: string) =>
        regionIds
          .map((id, i) => ({ id, i }))
          .filter((e) => e.id?.startsWith(prefix))
          .map((e) => e.i);
      expect(contiguous(runOf('regionL-'))).toBe(true);
      expect(contiguous(runOf('regionR-'))).toBe(true);
    });

    it('lets the nearest region win when regions nest', () => {
      const outer = new TestInteractiveEntity('outer');
      outer.x = 0;
      outer.y = 0;
      outer.width = 1200;
      outer.height = 600;
      outer.a11yRegion = true;
      outer.interactive = false;

      // Two nested columns inside one outer region. If the nearest region did
      // not win, both would band against each other under `outer`.
      const mkInner = (name: string, x: number) => {
        const inner = new TestInteractiveEntity(name);
        inner.x = x;
        inner.y = 0;
        inner.width = 400;
        inner.height = 600;
        inner.a11yRegion = true;
        inner.interactive = false;
        return inner;
      };
      const innerA = mkInner('inner-a', 0);
      const innerB = mkInner('inner-b', 500);

      [
        [innerA, 'a', [100, 300]],
        [innerB, 'b', [50, 200]],
      ].forEach(([owner, prefix, ys]) => {
        (ys as number[]).forEach((y, k) => {
          const child = new TestInteractiveEntity(`${prefix as string}-${k}`);
          child.x = 0;
          child.y = y;
          (owner as Entity).add(child);
        });
      });
      outer.add(innerA);
      outer.add(innerB);
      scene.add(outer);

      tick();

      const ids = idsInOrder();
      const runOf = (prefix: string) =>
        ids
          .map((id, i) => ({ id, i }))
          .filter((e) => e.id?.startsWith(prefix))
          .map((e) => e.i);
      const contiguous = (idx: number[]) => idx.every((v, k) => k === 0 || v === idx[k - 1] + 1);
      expect(contiguous(runOf('a-'))).toBe(true);
      expect(contiguous(runOf('b-'))).toBe(true);
    });
  });
});
