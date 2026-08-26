// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Dropdown } from '../src/Dropdown';
import { Entity, Scene } from '@vectojs/core';

describe('Dropdown', () => {
  beforeEach(() => {
    const originalGetContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (type: string) {
      if (type === '2d') {
        return {
          font: '',
          fillStyle: '',
          measureText: () => ({ width: 100 }),
          fillText: () => {},
          scale: () => {},
          clearRect: () => {},
          save: () => {},
          restore: () => {},
          translate: () => {},
          rotate: () => {},
          beginPath: () => {},
          rect: () => {},
          clip: () => {},
        } as any;
      }
      return originalGetContext.apply(this, arguments as any);
    };
  });

  it('opens overlay menu on click and closes on click outside', () => {
    const canvas = document.createElement('canvas');
    document.body.appendChild(canvas);
    const scene = new Scene(canvas);
    const dropdown = new Dropdown(['A', 'B', 'C'], { width: 100, height: 40 });
    scene.add(dropdown);

    expect(scene.overlayRoot.children.length).toBe(0);

    // Simulate click on Dropdown component
    dropdown.emit('click', { stopPropagation: () => {} });
    expect(scene.overlayRoot.children.length).toBeGreaterThan(0);
  });

  it('positions and sizes its menu from the transformed trigger bounds', () => {
    const canvas = document.createElement('canvas');
    document.body.appendChild(canvas);
    const scene = new Scene(canvas);
    const parent = new Entity('parent');
    parent.setPosition(100, 50);
    parent.scaleX = 2;
    parent.scaleY = 1.5;
    const dropdown = new Dropdown(['A', 'B'], { width: 100, height: 40 });
    dropdown.setPosition(10, 20);
    parent.add(dropdown);
    scene.add(parent);

    dropdown.emit('click', {});

    const menu = (dropdown as any).activeMenu;
    expect(menu.x).toBe(120);
    expect(menu.y).toBe(144);
    expect(menu.width).toBe(200);
    expect(menu.children[0].width).toBe(200);
  });

  it('flips above the trigger when the menu would overflow the scene bottom (#664)', () => {
    const canvas = document.createElement('canvas');
    document.body.appendChild(canvas);
    canvas.width = 800;
    canvas.height = 600;
    const scene = new Scene(canvas, { disableWindowResize: true });
    const dropdown = new Dropdown(['A', 'B', 'C'], { width: 100, height: 40 });
    dropdown.setPosition(20, 560); // 3 options → menu is 112px tall; nothing fits below
    scene.add(dropdown);

    dropdown.emit('click', {});

    const menu = (dropdown as any).activeMenu;
    // Flipped: bottom edge (menu.y + menu.height) stays inside the viewport.
    expect(menu.y + menu.height).toBeLessThanOrEqual(600);
    expect(menu.y).toBe(560 - 112 - 4);
  });

  it('clamps a menu that cannot fit either side into the top edge (#664)', () => {
    const canvas = document.createElement('canvas');
    document.body.appendChild(canvas);
    canvas.width = 800;
    canvas.height = 600;
    const scene = new Scene(canvas, { disableWindowResize: true });
    const options = Array.from({ length: 30 }, (_, i) => `opt-${i}`); // 1082px > scene
    const dropdown = new Dropdown(options, { width: 100, height: 40 });
    dropdown.setPosition(20, 560);
    scene.add(dropdown);

    dropdown.emit('click', {});

    const menu = (dropdown as any).activeMenu;
    // A menu taller than the viewport cannot fully fit anywhere
    // (Overlay._placeAt has the same property); clamping still keeps its top
    // edge at the minimum inset instead of leaving it below the trigger.
    expect(menu.y).toBe(4);
  });

  it('keeps a fitting menu inside the viewport when space below is short (#664)', () => {
    const canvas = document.createElement('canvas');
    document.body.appendChild(canvas);
    canvas.width = 800;
    canvas.height = 600;
    const scene = new Scene(canvas, { disableWindowResize: true });
    const options = Array.from({ length: 8 }, (_, i) => `opt-${i}`); // 302px menu
    const dropdown = new Dropdown(options, { width: 100, height: 40 });
    dropdown.setPosition(20, 560); // only ~0px below the trigger
    scene.add(dropdown);

    dropdown.emit('click', {});

    const menu = (dropdown as any).activeMenu;
    expect(menu.y + menu.height).toBeLessThanOrEqual(600);
    expect(menu.y).toBeGreaterThanOrEqual(4);
  });

  it('closes an open menu on Tab and lets focus move out (#693)', () => {
    const canvas = document.createElement('canvas');
    document.body.appendChild(canvas);
    const scene = new Scene(canvas);
    const dropdown = new Dropdown(['A', 'B'], { width: 100, height: 40 });
    scene.add(dropdown);

    dropdown.emit('click', { stopPropagation() {} });
    expect((dropdown as any).activeMenu).not.toBeNull();

    // Tab must close the menu AND keep its native default (focus movement).
    const preventDefault = vi.fn();
    dropdown.emit('keydown', { nativeEvent: { key: 'Tab' }, preventDefault });
    expect(preventDefault).not.toHaveBeenCalled();
    expect((dropdown as any).activeMenu).toBeNull();
    expect(scene.overlayRoot.children.length).toBe(0);
  });

  it('closes the menu on document-level Escape after focus moved out (#693)', () => {
    const canvas = document.createElement('canvas');
    document.body.appendChild(canvas);
    const scene = new Scene(canvas);
    const dropdown = new Dropdown(['A', 'B'], { width: 100, height: 40 });
    scene.add(dropdown);

    dropdown.emit('click', { stopPropagation() {} });
    expect((dropdown as any).activeMenu).not.toBeNull();

    // Focus has left the combobox (Tab path); Escape anywhere still closes.
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect((dropdown as any).activeMenu).toBeNull();
    expect(scene.overlayRoot.children.length).toBe(0);
  });

  it('derives unique backdrop ids per instance (#693)', () => {
    const canvas = document.createElement('canvas');
    document.body.appendChild(canvas);
    const scene = new Scene(canvas);
    const a = new Dropdown(['A'], { width: 100, height: 40 });
    const b = new Dropdown(['B'], { width: 100, height: 40 });
    scene.add(a);
    scene.add(b);

    a.emit('click', { stopPropagation() {} });
    b.emit('click', { stopPropagation() {} });

    const backdropA = (a as any).activeBackdrop as { id: string };
    const backdropB = (b as any).activeBackdrop as { id: string };
    expect(backdropA.id).not.toBe(backdropB.id);
    expect(backdropA.id).toBe(`${a.id}-backdrop`);
    expect(backdropB.id).toBe(`${b.id}-backdrop`);

    a.destroy();
    b.destroy();
  });
});

describe('Dropdown menu projection', () => {
  it('keeps the listbox container pointer-transparent so option clicks land on the option', () => {
    const canvas = document.createElement('canvas');
    document.body.appendChild(canvas);
    const scene = new Scene(canvas);
    const dropdown = new Dropdown(['A', 'B'], { width: 100, height: 40 });
    scene.add(dropdown);

    dropdown.emit('click', {});

    const menu = (dropdown as any).activeMenu;
    // The scene's per-mirror pointerdown handler calls setPointerCapture on
    // every projected element the gesture bubbles through. A hit-testable
    // listbox therefore overrides the option's own capture, and the browser
    // retargets pointerup + click to the container — which has no click
    // handler, so selecting an option silently did nothing.
    expect(menu.getA11yAttributes().pointerEvents).toBe('none');

    // Leaf options must stay clickable (the default).
    for (const child of menu.children) {
      const attrs = child.getA11yAttributes();
      expect(attrs.role).toBe('option');
      expect(attrs.pointerEvents ?? 'auto').toBe('auto');
    }
  });
});
