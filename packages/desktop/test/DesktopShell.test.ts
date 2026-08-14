// @vitest-environment jsdom
import { describe, expect, it, beforeEach, vi } from 'vitest';
import { Entity, Scene } from '@vectojs/core';
import { Text } from '@vectojs/ui';
import { DesktopShell, MemoryVfs, type AppDefinition } from '../src';

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

function makeScene(w = 800, h = 600): Scene {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  Object.defineProperty(canvas, 'getContext', { value: () => fakeCtx() });
  Object.defineProperty(canvas, 'clientWidth', { value: w });
  Object.defineProperty(canvas, 'clientHeight', { value: h });
  Object.defineProperty(canvas, 'getBoundingClientRect', {
    value: () => ({ left: 0, top: 0, width: w, height: h, right: w, bottom: h }),
  });
  return new Scene(canvas, {
    renderMode: 'onDemand',
    disableWindowResize: true,
  });
}

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

const aboutApp: AppDefinition = {
  id: 'about',
  title: 'About',
  icon: 'ℹ',
  create: () => new Text('About VectoJS Desktop', { selectable: false }),
};

const notesApp: AppDefinition = {
  id: 'notes',
  title: 'Notes',
  instances: 'multiple',
  create: () => new Box(100, 40),
};

describe('DesktopShell + WindowManager', () => {
  let scene: Scene;

  beforeEach(() => {
    scene = makeScene();
  });

  it('starts with wallpaper and taskbar and opens a window', () => {
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

  it('single-instance focuses existing; multiple spawns', () => {
    const shell = new DesktopShell({
      scene,
      config: { apps: [aboutApp, notesApp] },
    });
    shell.start();
    const a1 = shell.open('about');
    const a2 = shell.open('about');
    expect(a2).toBe(a1);
    expect(shell.windowManager.listByApp('about')).toHaveLength(1);

    const n1 = shell.open('notes');
    const n2 = shell.open('notes');
    expect(n2).not.toBe(n1);
    expect(shell.windowManager.listByApp('notes')).toHaveLength(2);
    shell.dispose();
  });

  it('focuses and z-orders the most recently activated window', () => {
    const shell = new DesktopShell({
      scene,
      config: { apps: [aboutApp, notesApp] },
    });
    shell.start();
    const a = shell.open('about');
    const c = shell.open('notes');
    expect(shell.windowManager.focusedWindow).toBe(c);
    expect(scene.overlayRoot.children.at(-1)).toBe(c);

    shell.windowManager.focus(a);
    expect(shell.windowManager.focusedWindow).toBe(a);
    expect(scene.overlayRoot.children.at(-1)).toBe(a);
    shell.dispose();
  });

  it('maximize fills work area; restore returns geometry', () => {
    const shell = new DesktopShell({
      scene,
      config: {
        apps: [aboutApp],
        desktop: { taskbarHeight: 40, taskbarPosition: 'bottom' },
      },
    });
    shell.start();
    const win = shell.open('about');
    const ox = win.x;
    const oy = win.y;
    const ow = win.width;
    const oh = win.height;
    win.maximize();
    expect(win.maximized).toBe(true);
    const area = shell.layout.workArea();
    expect(win.x).toBe(area.x);
    expect(win.y).toBe(area.y);
    expect(win.width).toBe(area.width);
    expect(win.height).toBe(area.height);
    win.restore();
    expect(win.maximized).toBe(false);
    expect(win.x).toBe(ox);
    expect(win.y).toBe(oy);
    expect(win.width).toBe(ow);
    expect(win.height).toBe(oh);
    shell.dispose();
  });

  it('minimize hides and taskbar focus restores', () => {
    const shell = new DesktopShell({
      scene,
      config: { apps: [aboutApp] },
    });
    shell.start();
    const win = shell.open('about');
    win.minimize();
    expect(win.minimized).toBe(true);
    expect(win.opacity).toBe(0);
    shell.windowManager.focus(win);
    expect(win.minimized).toBe(false);
    expect(win.opacity).toBe(1);
    shell.dispose();
  });

  it('close focuses the next topmost non-minimized window', () => {
    const shell = new DesktopShell({
      scene,
      config: { apps: [aboutApp, notesApp] },
    });
    shell.start();
    const a = shell.open('about');
    const c = shell.open('notes');
    shell.windowManager.close(c);
    expect(shell.windowManager.list()).toEqual([a]);
    expect(shell.windowManager.focusedWindow).toBe(a);
    shell.dispose();
  });

  it('start menu toggles and launches apps', () => {
    const shell = new DesktopShell({
      scene,
      config: { apps: [aboutApp] },
    });
    shell.start();
    shell.toggleStartMenu();
    expect(scene.overlayRoot.children.some((c) => c !== shell.windowManager.list()[0])).toBe(true);
    shell.toggleStartMenu();
    shell.dispose();
  });

  it('shortcut router opens apps and closes focused', () => {
    const shell = new DesktopShell({
      scene,
      config: {
        apps: [aboutApp],
        shortcuts: {
          'Control+n': { type: 'open-app', appId: 'about' },
          'Meta+w': { type: 'close-focused' },
        },
      },
    });
    shell.start();
    document.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'n', ctrlKey: true, bubbles: true }),
    );
    expect(shell.windowManager.list()).toHaveLength(1);
    document.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'w', metaKey: true, bubbles: true }),
    );
    expect(shell.windowManager.list()).toHaveLength(0);
    shell.dispose();
  });

  it('multi-display work areas and clamp', () => {
    const shell = new DesktopShell({
      scene: makeScene(1600, 600),
      config: {
        apps: [aboutApp],
        desktop: {
          displays: [
            { id: 'left', x: 0, y: 0, width: 800, height: 600 },
            { id: 'right', x: 800, y: 0, width: 800, height: 600 },
          ],
          taskbarHeight: 40,
        },
      },
    });
    shell.start();
    expect(shell.layout.list()).toHaveLength(2);
    const right = shell.layout.workArea('right');
    expect(right.x).toBe(800);
    expect(right.height).toBe(560);
    const win = shell.open('about', { displayId: 'right', x: 900, y: 100 });
    expect(win.x).toBeGreaterThanOrEqual(800);
    shell.dispose();
  });

  it('exposes vfs on app context', async () => {
    const vfs = new MemoryVfs();
    await vfs.write('/hello.txt', 'hi');
    let seen: string | null = null;
    const app: AppDefinition = {
      id: 'files',
      title: 'Files',
      create: (ctx) => {
        void ctx.vfs?.read('/hello.txt').then((s) => {
          seen = s;
        });
        return new Box(10, 10);
      },
    };
    const shell = new DesktopShell({
      scene,
      config: { apps: [app], vfs },
    });
    shell.start();
    shell.open('files');
    await new Promise((r) => setTimeout(r, 0));
    expect(seen).toBe('hi');
    shell.dispose();
  });

  it('throws on unknown app id and after dispose', () => {
    const shell = new DesktopShell({ scene, config: { apps: [] } });
    shell.start();
    expect(() => shell.open('nope')).toThrow(/unknown app/);
    shell.dispose();
    expect(() => shell.open('nope')).toThrow(/disposed/);
  });
});

describe('review fixes (CTX-0368)', () => {
  it('uses VectoJSEvent local/scene coords for titlebar drag (not offsetX)', () => {
    const scene = makeScene();
    const shell = new DesktopShell({
      scene,
      config: { apps: [aboutApp], desktop: { taskbarHeight: 0 } },
    });
    shell.start();
    const win = shell.open('about');
    const startX = win.x;
    const startY = win.y;
    // Synthetic Vecto-style event: local coords in window space, scene absolute.
    win.emit('pointerdown', {
      localX: 20,
      localY: 10, // inside titlebar
      sceneX: startX + 20,
      sceneY: startY + 10,
      clientX: startX + 20,
      clientY: startY + 10,
    });
    // Document move in client pixels (= scene when canvas origin 0 and scale 1)
    window.dispatchEvent(
      new PointerEvent('pointermove', {
        clientX: startX + 20 + 40,
        clientY: startY + 10 + 15,
        bubbles: true,
      }),
    );
    window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
    expect(win.x).toBeCloseTo(startX + 40, 0);
    expect(win.y).toBeCloseTo(startY + 15, 0);
    shell.dispose();
  });

  it('releases a11y projection on the previous focused window', () => {
    const scene = makeScene();
    const spyRelease = vi.spyOn(scene, 'releaseA11yProjection');
    const shell = new DesktopShell({
      scene,
      config: { apps: [aboutApp, notesApp] },
    });
    shell.start();
    const a = shell.open('about');
    const n = shell.open('notes');
    // notes focused; switching back to about should release notes
    spyRelease.mockClear();
    shell.windowManager.focus(a);
    expect(spyRelease).toHaveBeenCalledWith(n);
    shell.dispose();
  });

  it('restack does not call Entity.remove (keeps a11y attached)', () => {
    const scene = makeScene();
    const shell = new DesktopShell({
      scene,
      config: { apps: [aboutApp, notesApp] },
    });
    shell.start();
    const a = shell.open('about');
    const n = shell.open('notes');
    const removeSpy = vi.spyOn(scene.overlayRoot, 'remove');
    shell.windowManager.focus(a);
    expect(removeSpy).not.toHaveBeenCalled();
    expect(scene.overlayRoot.children.at(-1)).toBe(a);
    expect(scene.overlayRoot.children).toContain(n);
    shell.dispose();
  });

  it('pointercancel ends an in-flight drag', () => {
    const scene = makeScene();
    const shell = new DesktopShell({
      scene,
      config: { apps: [aboutApp], desktop: { taskbarHeight: 0 } },
    });
    shell.start();
    const win = shell.open('about');
    const startX = win.x;
    win.emit('pointerdown', {
      localX: 20,
      localY: 10,
      sceneX: startX + 20,
      sceneY: win.y + 10,
      clientX: startX + 20,
      clientY: win.y + 10,
    });
    window.dispatchEvent(
      new PointerEvent('pointermove', {
        clientX: startX + 60,
        clientY: win.y + 10,
        bubbles: true,
      }),
    );
    expect(win.x).toBeCloseTo(startX + 40, 0);
    window.dispatchEvent(new PointerEvent('pointercancel', { bubbles: true }));
    // Further moves must not drag after cancel.
    const mid = win.x;
    window.dispatchEvent(
      new PointerEvent('pointermove', {
        clientX: startX + 200,
        clientY: win.y + 10,
        bubbles: true,
      }),
    );
    expect(win.x).toBe(mid);
    shell.dispose();
  });
});
