// @vitest-environment jsdom
import { describe, expect, it, beforeEach } from 'vitest';
import { Entity, Scene } from '@vectojs/core';
import { Text } from '@vectojs/ui';
import { DesktopShell, type AppDefinition } from '../src';

function fakeCtx(): CanvasRenderingContext2D {
  return new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === 'measureText') return (t: string) => ({ width: String(t).length * 8 });
        if (prop === 'canvas') return { width: 800, height: 600, style: {} };
        return () => {};
      },
      set: () => true,
    },
  ) as unknown as CanvasRenderingContext2D;
}

function makeScene(): Scene {
  const canvas = document.createElement('canvas');
  canvas.width = 800;
  canvas.height = 600;
  Object.defineProperty(canvas, 'getContext', {
    value: () => fakeCtx(),
  });
  Object.defineProperty(canvas, 'clientWidth', { value: 800 });
  Object.defineProperty(canvas, 'clientHeight', { value: 600 });
  return new Scene(canvas, {
    renderMode: 'onDemand',
    disableWindowResize: true,
  });
}

const aboutApp: AppDefinition = {
  id: 'about',
  title: 'About',
  create: () => new Text('About VectoJS Desktop', { selectable: false }),
};

class Box extends Entity {
  constructor(w: number, h: number) {
    super();
    this.width = w;
    this.height = h;
  }
  override isPointInside(): boolean {
    return false;
  }
  override render(): void {}
}

const clockApp: AppDefinition = {
  id: 'clock',
  title: 'Clock',
  create: () => new Box(100, 40),
};

describe('DesktopShell + WindowManager', () => {
  let scene: Scene;

  beforeEach(() => {
    scene = makeScene();
  });

  it('starts with wallpaper and opens a window from the registry', () => {
    const shell = new DesktopShell({
      scene,
      config: { apps: [aboutApp] },
    });
    shell.start();
    expect(scene.root.children.length).toBeGreaterThanOrEqual(1);

    const win = shell.open('about');
    expect(win.appId).toBe('about');
    expect(win.a11yProjection).toBe('onDemand');
    expect(win.focused).toBe(true);
    expect(scene.overlayRoot.children).toContain(win);
    expect(shell.windowManager.list()).toHaveLength(1);

    shell.dispose();
    expect(shell.windowManager.list()).toHaveLength(0);
  });

  it('focuses and z-orders the most recently activated window', () => {
    const shell = new DesktopShell({
      scene,
      config: { apps: [aboutApp, clockApp] },
    });
    shell.start();
    const a = shell.open('about');
    const c = shell.open('clock');
    expect(shell.windowManager.focusedWindow).toBe(c);
    expect(a.focused).toBe(false);
    expect(c.focused).toBe(true);

    const overlays = scene.overlayRoot.children;
    expect(overlays[overlays.length - 1]).toBe(c);

    shell.windowManager.focus(a);
    expect(shell.windowManager.focusedWindow).toBe(a);
    expect(a.focused).toBe(true);
    expect(c.focused).toBe(false);
    expect(scene.overlayRoot.children.at(-1)).toBe(a);

    shell.dispose();
  });

  it('re-open of the same app focuses the existing window (single instance)', () => {
    const shell = new DesktopShell({
      scene,
      config: { apps: [aboutApp, clockApp] },
    });
    shell.start();
    const first = shell.open('about');
    shell.open('clock');
    const second = shell.open('about');
    expect(second).toBe(first);
    expect(shell.windowManager.list()).toHaveLength(2);
    expect(shell.windowManager.focusedWindow).toBe(first);
    shell.dispose();
  });

  it('close focuses the next topmost window', () => {
    const shell = new DesktopShell({
      scene,
      config: { apps: [aboutApp, clockApp] },
    });
    shell.start();
    const a = shell.open('about');
    const c = shell.open('clock');
    shell.windowManager.close(c);
    expect(shell.windowManager.list()).toEqual([a]);
    expect(shell.windowManager.focusedWindow).toBe(a);
    shell.windowManager.close(a);
    expect(shell.windowManager.list()).toHaveLength(0);
    expect(shell.windowManager.focusedWindow).toBeNull();
    shell.dispose();
  });

  it('throws on unknown app id', () => {
    const shell = new DesktopShell({ scene, config: { apps: [] } });
    shell.start();
    expect(() => shell.open('nope')).toThrow(/unknown app/);
    shell.dispose();
  });

  it('rejects use after dispose', () => {
    const shell = new DesktopShell({ scene, config: { apps: [aboutApp] } });
    shell.dispose();
    expect(() => shell.open('about')).toThrow(/disposed/);
  });
});
