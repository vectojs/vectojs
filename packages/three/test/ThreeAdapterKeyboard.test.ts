// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ThreeAdapter } from '../src/ThreeAdapter';
import { Entity, VectoJSEvent } from '@vectojs/core';
import * as THREE from 'three';

// Mock WebGLRenderer & CanvasTexture to run in JSDOM headless environment
vi.mock('three', async () => {
  const actual = await vi.importActual<typeof import('three')>('three');

  class MockCanvasTexture {
    public needsUpdate = false;
    public version = 0;
    public minFilter = 0;
    public magFilter = 0;
    constructor(public image: any) {}
    dispose = vi.fn();
  }

  class MockMesh {
    parent: any = null;
    constructor(
      public geometry: any,
      public material: any,
    ) {}
  }

  return {
    ...actual,
    CanvasTexture: MockCanvasTexture as any,
    Mesh: MockMesh as any,
  };
});

/** A rectangular entity with configurable a11y attributes for focus tests. */
class Panel extends Entity {
  constructor(
    id: string,
    private readonly attrs: Record<string, unknown> = {},
  ) {
    super(id);
  }
  isPointInside(x: number, y: number) {
    return x >= this.x && x <= this.x + this.width && y >= this.y && y <= this.y + this.height;
  }
  render() {}
  override getA11yAttributes(): any {
    return this.attrs;
  }
}

function uvFor(x: number, y: number): THREE.Vector2 {
  // Logical scene point -> Three.js UV (origin bottom-left).
  return new THREE.Vector2(x / 800, 1 - y / 600);
}

function raycasterAt(x: number, y: number): THREE.Raycaster {
  return { intersectObject: () => [{ uv: uvFor(x, y) }] } as unknown as THREE.Raycaster;
}

const missRaycaster = { intersectObject: () => [] } as unknown as THREE.Raycaster;

describe('ThreeAdapter keyboard routing, focus and programmatic input', () => {
  let adapter: ThreeAdapter;

  beforeEach(() => {
    HTMLCanvasElement.prototype.getContext = function () {
      return {
        scale: () => {},
        clearRect: () => {},
        save: () => {},
        restore: () => {},
        translate: () => {},
        rotate: () => {},
        clip: () => {},
        beginPath: () => {},
        rect: () => {},
        moveTo: () => {},
        lineTo: () => {},
        arc: () => {},
        fill: () => {},
        stroke: () => {},
        fillText: () => {},
        drawImage: () => {},
        measureText: () => ({ width: 100 }),
        canvas: this,
      } as any;
    } as any;

    adapter = new ThreeAdapter({ width: 800, height: 600 });
  });

  afterEach(() => {
    adapter.dispose();
    // Channel tests focus host-page inputs; drop them so later tests see body.
    for (const el of document.querySelectorAll('input[data-test-host]')) el.remove();
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  });

  function addPanel(
    id: string,
    attrs: Record<string, unknown>,
    box = { x: 100, y: 100, w: 100, h: 100 },
  ): Panel {
    const panel = new Panel(id, attrs).setPosition(box.x, box.y);
    panel.width = box.w;
    panel.height = box.h;
    panel.interactive = true;
    adapter.vectoScene.add(panel);
    adapter.vectoScene.render(adapter.vectoScene.getRenderer(), 16, 16);
    (adapter.vectoScene as any).syncA11y((adapter.vectoScene as any).root);
    return panel;
  }

  describe('keyboard routing', () => {
    it('delivers a synthesized keydown/keyup pair to the focused entity with real KeyboardEvent shapes', () => {
      const field = addPanel('kbd-field', { role: 'textbox', tabIndex: 0 });
      adapter.focus(field);

      type Captured = { type: string; e: VectoJSEvent };
      const captured: Captured[] = [];
      field.on('keydown', (e: any) => captured.push({ type: 'keydown', e }));
      field.on('keyup', (e: any) => captured.push({ type: 'keyup', e }));

      adapter.dispatchKey('ArrowLeft', { shiftKey: true, ctrlKey: true });

      expect(captured.map((c) => c.type)).toEqual(['keydown', 'keyup']);
      for (const { e } of captured) {
        expect(e.target).toBe(field);
        expect(e.nativeEvent).toBeInstanceOf(KeyboardEvent);
        const native = e.nativeEvent as KeyboardEvent;
        expect(native.key).toBe('ArrowLeft');
        expect(native.shiftKey).toBe(true);
        expect(native.ctrlKey).toBe(true);
        expect(native.altKey).toBe(false);
        expect(native.metaKey).toBe(false);
        expect(native.repeat).toBe(false);
      }
      // The synthesized shape matches a real KeyboardEvent built the same way.
      const realShape = new KeyboardEvent('keydown', {
        key: 'ArrowLeft',
        code: 'ArrowLeft',
        shiftKey: true,
        ctrlKey: true,
      });
      const synthetic = captured[0].e.nativeEvent as KeyboardEvent;
      for (const prop of ['key', 'code', 'shiftKey', 'ctrlKey', 'altKey', 'metaKey'] as const) {
        expect(synthetic[prop]).toBe(realShape[prop]);
      }
    });

    it('routes through the projection so Enter activates a focused projected button (#694 contract)', () => {
      const button = addPanel('kbd-button', { role: 'button', label: 'Go' });
      adapter.focus(button);

      let clicks = 0;
      button.on('click', () => clicks++);
      let keydowns = 0;
      button.on('keydown', () => keydowns++);

      adapter.dispatchKey('Enter');
      expect(keydowns).toBe(1);
      expect(clicks).toBe(1); // core's mirror listener turns Enter into activation

      let spaceClicks = 0;
      button.on('click', () => spaceClicks++);
      adapter.dispatchKey(' ', { code: 'Space' }, 'keyup');
      expect(spaceClicks).toBe(1); // APG: Space activates on RELEASE
    });

    it('forwards keys into the #636 scene channel when no panel entity holds focus', () => {
      adapter.vectoScene.start();
      const seen: string[] = [];
      adapter.vectoScene.registerShortcut({ chord: 'ArrowLeft', handler: () => seen.push('left') });

      adapter.dispatchKey('ArrowLeft');

      expect(seen).toEqual(['left']);
    });

    it('does not steal keys from a page-level keyboard owner (ownership gating)', () => {
      adapter.vectoScene.start();
      const seen: string[] = [];
      adapter.vectoScene.on('keydown', (e) => seen.push(e.key));

      const host = document.createElement('input');
      host.setAttribute('data-test-host', '');
      document.body.appendChild(host);
      host.focus();
      expect(document.activeElement).toBe(host);

      adapter.dispatchKey('a');

      expect(seen).toEqual([]); // ownsKeyboard(activeElement) gate held
    });

    it('gives a keyboard-owning panel role exclusive use of keys while focused', () => {
      const field = addPanel('own-field', { role: 'textbox', tabIndex: 0 });
      adapter.vectoScene.start();
      const channelKeys: string[] = [];
      adapter.vectoScene.on('keydown', (e) => channelKeys.push(e.key));
      let fieldKeys = 0;
      field.on('keydown', () => fieldKeys++);

      adapter.focus(field);
      adapter.dispatchKey('a');

      expect(fieldKeys).toBe(1);
      expect(channelKeys).toEqual([]); // panel owns the keyboard exclusively
    });

    it('still reaches the scene channel from a tabIndex-only focused node, unless the event is prevented', () => {
      // Every interactive ARIA role is keyboard-owning per #636, so the
      // non-owning case is a node made reachable purely via explicit tabIndex.
      const region = addPanel('bubbling-region', { tabIndex: 0 });
      adapter.vectoScene.start();
      const channelKeys: string[] = [];
      adapter.vectoScene.on('keydown', (e) => channelKeys.push(e.key));
      adapter.focus(region);

      adapter.dispatchKey('x');
      expect(channelKeys).toEqual(['x']); // bubbles like a connected mirror would

      region.on('keydown', (e) => (e.nativeEvent as KeyboardEvent).preventDefault());
      adapter.dispatchKey('y');
      expect(channelKeys).toEqual(['x']); // defaultPrevented gate clause kept the channel silent
    });
  });

  describe('focus management', () => {
    it('focuses the hit entity on pointerdown and bridges focus through the projection', () => {
      const field = addPanel('focus-field', { role: 'textbox', tabIndex: 0 });
      let focusEmits = 0;
      field.on('focus', () => focusEmits++);

      adapter.updateIntersection(raycasterAt(150, 150), 'pointerdown');

      expect(adapter.focusedEntity).toBe(field);
      expect(focusEmits).toBe(1);
      // The synthetic FocusEvent drove core's own listener: the scene now tracks
      // the mirror as its focused element exactly like a connected canvas.
      expect((adapter.vectoScene as any).focusedA11yElement).toBeTruthy();
    });

    it('walks up to the nearest focusable ancestor when the hit entity is not focusable', () => {
      const parent = addPanel('focus-parent', { role: 'button', label: 'P' });
      const child = new Panel('focus-child', {}).setPosition(120, 120);
      child.width = 40;
      child.height = 40;
      child.interactive = true;
      parent.add(child);
      adapter.vectoScene.render(adapter.vectoScene.getRenderer(), 16, 16);
      (adapter.vectoScene as any).syncA11y((adapter.vectoScene as any).root);

      adapter.updateIntersection(raycasterAt(130, 130), 'pointerdown');

      expect(adapter.focusedEntity).toBe(parent);
    });

    it('blurs when clicking outside the mesh entirely', () => {
      const field = addPanel('blur-field', { role: 'textbox', tabIndex: 0 });
      adapter.focus(field);
      let blurs = 0;
      field.on('blur', () => blurs++);

      const hit = adapter.updateIntersection(missRaycaster, 'pointerdown');

      expect(hit).toBe(false);
      expect(adapter.focusedEntity).toBeNull();
      expect(blurs).toBe(1);
    });

    it('blurs when clicking empty panel background (no entity hit)', () => {
      const field = addPanel('bg-field', { role: 'textbox', tabIndex: 0 });
      adapter.focus(field);

      adapter.updateIntersection(raycasterAt(700, 500), 'pointerdown');

      expect(adapter.focusedEntity).toBeNull();
    });

    it('supports programmatic focus()/blur() and reports focusability per the projection rules', () => {
      const field = addPanel('prog-field', { role: 'textbox', tabIndex: 0 });
      const plain = addPanel('prog-plain', {});
      const implicit = addPanel('prog-implicit', { role: 'slider' });

      expect(adapter.isFocusable(field)).toBe(true); // explicit tabIndex
      expect(adapter.isFocusable(implicit)).toBe(true); // interactive role -> implicit tabindex=0
      expect(adapter.isFocusable(plain)).toBe(false); // no projection-declared focusability

      const dirtySpy = vi.spyOn(adapter.vectoScene, 'markDirty');
      adapter.focus(field);
      expect(adapter.focusedEntity).toBe(field);
      adapter.blur();
      expect(adapter.focusedEntity).toBeNull();
      expect(dirtySpy).toHaveBeenCalled(); // repaint scheduled for caret/focus visuals
    });

    it('clears focus state on dispose without emitting after destroy', () => {
      const field = addPanel('disp-field', { role: 'textbox', tabIndex: 0 });
      adapter.focus(field);
      expect(adapter.focusedEntity).toBe(field);

      adapter.dispose();

      expect(adapter.focusedEntity).toBeNull();
    });
  });

  describe('programmatic input driving', () => {
    function capturePointer(panel: Entity): { events: VectoJSEvent[]; last: () => VectoJSEvent } {
      const events: VectoJSEvent[] = [];
      panel.on('pointerdown', (e: any) => events.push(e));
      panel.on('pointerup', (e: any) => events.push(e));
      panel.on('click', (e: any) => events.push(e));
      panel.on('pointermove', (e: any) => events.push(e));
      return { events, last: () => events[events.length - 1] };
    }

    it('dispatches pointer input at logical scene coordinates and reports the hit', () => {
      const panel = addPanel('drive-panel', {});
      const { last } = capturePointer(panel);

      const inside = adapter.dispatchPointer('click', 150, 150);
      expect(inside).toBe(true);
      const click = last() as VectoJSEvent & { clientX: number; clientY: number };
      expect(click.type).toBe('click');
      expect(click.clientX).toBe(150);
      expect(click.clientY).toBe(150);

      const outside = adapter.dispatchPointer('click', 5, 5);
      expect(outside).toBe(false);
    });

    it('produces the same downstream payload as a real raycaster-driven event', () => {
      const panel = addPanel('parity-panel', {});

      const collect =
        (sink: Array<Record<string, unknown>>) =>
        (e: VectoJSEvent): void => {
          sink.push({
            type: e.type,
            sceneX: (e as any).sceneX,
            sceneY: (e as any).sceneY,
            localX: (e as any).localX,
            localY: (e as any).localY,
            clientX: (e.nativeEvent as PointerEvent).clientX,
            clientY: (e.nativeEvent as PointerEvent).clientY,
            pointerId: (e.nativeEvent as PointerEvent).pointerId,
            targetId: e.target.id,
          });
        };

      // Path 1: the real host loop (raycast UV -> logical px -> dispatch).
      // Hosts normally forward the original DOM event, so provide one shaped
      // exactly like what a page listener would hand over.
      const viaRaycaster: Array<Record<string, unknown>> = [];
      const h1 = collect(viaRaycaster);
      panel.on('pointerdown', h1);
      adapter.updateIntersection(
        raycasterAt(150, 150),
        'pointerdown',
        new PointerEvent('pointerdown', { pointerId: 1, clientX: 150, clientY: 150 }),
      );
      panel.off('pointerdown', h1);

      // Path 2: the programmatic driver at the same logical point.
      const viaDispatch: Array<Record<string, unknown>> = [];
      const h2 = collect(viaDispatch);
      panel.on('pointerdown', h2);
      adapter.dispatchPointer('pointerdown', 150, 150);

      expect(viaRaycaster.length).toBe(1);
      expect(viaDispatch).toEqual(viaRaycaster);
    });

    it('defaults to a full press but allows explicit phase control', () => {
      const field = addPanel('phase-field', { role: 'textbox', tabIndex: 0 });
      adapter.focus(field);
      const phases: string[] = [];
      field.on('keydown', (e: any) => phases.push(`kd:${(e.nativeEvent as KeyboardEvent).key}`));
      field.on('keyup', (e: any) => phases.push(`ku:${(e.nativeEvent as KeyboardEvent).key}`));

      adapter.dispatchKey('Enter'); // press = down + up
      expect(phases).toEqual(['kd:Enter', 'ku:Enter']);

      phases.length = 0;
      adapter.dispatchKey('Escape', {}, 'keydown');
      expect(phases).toEqual(['kd:Escape']);

      phases.length = 0;
      adapter.dispatchKey('Escape', {}, 'keyup');
      expect(phases).toEqual(['ku:Escape']);
    });
  });
});
