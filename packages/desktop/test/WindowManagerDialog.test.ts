// @vitest-environment jsdom
import { describe, expect, it, beforeEach } from 'vitest';
import { Entity, Scene } from '@vectojs/core';
import { Button } from '@vectojs/ui';
import { DesktopShell, StartMenu, type AppContext, type AppDefinition } from '../src';

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
  create: () => new Box(100, 40),
};

const notesApp: AppDefinition = {
  id: 'notes',
  title: 'Notes',
  instances: 'multiple',
  create: () => new Box(100, 40),
};

/** Visible button labels in an entity subtree (taskbar entries, menu rows). */
function buttonLabels(root: Entity | null | undefined): string[] {
  const out: string[] = [];
  const walk = (e: Entity | null | undefined): void => {
    if (!e) return;
    if (e instanceof Button) out.push(e.label);
    for (const c of e.children) walk(c);
  };
  walk(root);
  return out;
}

describe('WindowManager.openDialog (CTX-0458)', () => {
  let scene: Scene;

  beforeEach(() => {
    scene = makeScene();
  });

  it('opens without any registry entry and renders the content entity', () => {
    const shell = new DesktopShell({ scene, config: { apps: [] } });
    shell.start();
    const box = new Box(120, 60);
    let seenCtx: AppContext | null = null;
    const dlg = shell.openDialog({
      title: 'Confirm',
      content: (ctx) => {
        seenCtx = ctx;
        return box;
      },
    });

    expect(dlg.isDialog).toBe(true);
    expect(dlg.appId).toBe('dialog');
    expect(shell.registry.get('dialog')).toBeUndefined();
    expect(shell.windowManager.list()).toEqual([dlg]);
    expect(dlg.focused).toBe(true);
    expect(scene.overlayRoot.children).toContain(dlg);
    expect(dlg.clientContent).toBe(box);
    expect(seenCtx).not.toBeNull();
    expect(seenCtx!.windowId).toBe(dlg.windowId);

    // The builder context can dismiss its own dialog.
    seenCtx!.close();
    expect(shell.windowManager.list()).toHaveLength(0);
    shell.dispose();
  });

  it('has close-only chrome: no minimize/maximize buttons and no dblclick maximize', () => {
    const shell = new DesktopShell({ scene, config: { apps: [] } });
    shell.start();
    const dlg = shell.openDialog({ title: 'Lean', content: () => new Box(10, 10) });

    const labels = dlg.children
      .flatMap((c) => c.children)
      .filter((e): e is Button => e instanceof Button)
      .map((b) => b.getA11yAttributes().label);
    expect(labels).toContain('Close');
    expect(labels).not.toContain('Minimize');
    expect(labels).not.toContain('Maximize');

    const handle = (dlg as unknown as { dragHandle: { emit: (t: string, e: object) => void } })
      .dragHandle;
    handle.emit('dblclick', {});
    expect(dlg.maximized).toBe(false);
    shell.dispose();
  });

  it('modal dialog holds focus; refocus of other windows blocked until closed', () => {
    const shell = new DesktopShell({ scene, config: { apps: [aboutApp, notesApp] } });
    shell.start();
    const a = shell.open('about');
    const dlg = shell.openDialog({ title: 'Modal', content: () => new Box(10, 10) });

    expect(shell.windowManager.focusedWindow).toBe(dlg);
    shell.windowManager.focus(a);
    expect(shell.windowManager.focusedWindow).toBe(dlg);
    shell.windowManager.cycleFocus();
    expect(shell.windowManager.focusedWindow).toBe(dlg);

    shell.windowManager.close(dlg);
    expect(shell.windowManager.focusedWindow).toBe(a);

    // Modality lifted: normal open/focus flow works again.
    const n = shell.open('notes');
    expect(shell.windowManager.focusedWindow).toBe(n);
    shell.dispose();
  });

  it('non-modal dialog allows refocus; close restores the opener, not the topmost', () => {
    const shell = new DesktopShell({ scene, config: { apps: [aboutApp, notesApp] } });
    shell.start();
    const a = shell.open('about');
    const n = shell.open('notes');
    const dlg = shell.openDialog({
      title: 'NonModal',
      modal: false,
      content: () => new Box(10, 10),
    });

    shell.windowManager.focus(a);
    expect(shell.windowManager.focusedWindow).toBe(a);

    // Opener was notes; topmost remaining after close is about.
    shell.windowManager.close(dlg);
    expect(shell.windowManager.focusedWindow).toBe(n);
    expect(n.focused).toBe(true);
    expect(a.focused).toBe(false);
    shell.dispose();
  });

  it('nested dialogs restore focus down the stack', () => {
    const shell = new DesktopShell({ scene, config: { apps: [aboutApp] } });
    shell.start();
    const a = shell.open('about');
    const d1 = shell.openDialog({ title: 'L1', content: () => new Box(10, 10) });
    const d2 = shell.openDialog({ title: 'L2', content: () => new Box(10, 10) });
    expect(shell.windowManager.focusedWindow).toBe(d2);

    shell.windowManager.close(d2);
    expect(shell.windowManager.focusedWindow).toBe(d1);
    shell.windowManager.close(d1);
    expect(shell.windowManager.focusedWindow).toBe(a);
    shell.dispose();
  });

  it('escape closes a dismissible dialog only', () => {
    const shell = new DesktopShell({ scene, config: { apps: [] } });
    shell.start();

    shell.openDialog({ title: 'Escapable', content: () => new Box(10, 10) });
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(shell.windowManager.list()).toHaveLength(0);

    const sticky = shell.openDialog({
      title: 'Sticky',
      dismissible: false,
      content: () => new Box(10, 10),
    });
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(shell.windowManager.list()).toEqual([sticky]);
    expect(sticky.focused).toBe(true);
    shell.dispose();
    expect(() => shell.openDialog({ title: 'X', content: () => new Box(1, 1) })).toThrow(
      /disposed/,
    );
  });

  it('projects role=dialog named by title with ariaModal on modals', () => {
    const shell = new DesktopShell({ scene, config: { apps: [] } });
    shell.start();
    const modal = shell.openDialog({ title: 'AreYouSure', content: () => new Box(10, 10) });
    expect(modal.getA11yAttributes()).toMatchObject({
      role: 'dialog',
      label: 'AreYouSure',
      ariaModal: 'true',
    });

    const modeless = shell.openDialog({
      title: 'Modeless',
      modal: false,
      content: () => new Box(10, 10),
    });
    expect(modeless.getA11yAttributes()).toMatchObject({
      role: 'dialog',
      label: 'Modeless',
      ariaModal: 'false',
    });
    shell.dispose();
  });

  it('excludes dialogs from taskbar entries and the start menu', () => {
    const shell = new DesktopShell({ scene, config: { apps: [aboutApp] } });
    shell.start();
    shell.open('about');
    shell.openDialog({ title: 'TransientPrompt', content: () => new Box(10, 10) });

    const tb = buttonLabels(shell.taskbar);
    expect(tb.some((l) => l.includes('About'))).toBe(true);
    expect(tb.some((l) => l.includes('TransientPrompt'))).toBe(false);

    shell.toggleStartMenu();
    const menu = scene.overlayRoot.children.find((c) => c instanceof StartMenu);
    expect(menu).toBeDefined();
    const sm = buttonLabels(menu);
    expect(sm.some((l) => l.includes('About'))).toBe(true);
    expect(sm.some((l) => l.includes('TransientPrompt'))).toBe(false);
    shell.dispose();
  });

  it('centers on the work area by default and clamps oversized or negative geometry', () => {
    const shell = new DesktopShell({
      scene,
      config: { apps: [], desktop: { taskbarHeight: 40 } },
    });
    shell.start();
    const area = shell.layout.workArea();
    expect(area).toMatchObject({ x: 0, y: 0, width: 800, height: 560 });

    const d = shell.openDialog({
      title: 'Centered',
      width: 300,
      height: 200,
      content: () => new Box(10, 10),
    });
    expect(d.x).toBe(Math.round((800 - 300) / 2));
    expect(d.y).toBe(Math.round((560 - 200) / 2));

    const big = shell.openDialog({
      title: 'TooBig',
      width: 2000,
      height: 1000,
      content: () => new Box(10, 10),
    });
    expect(big.width).toBe(area.width);
    expect(big.height).toBe(area.height);
    expect(big.x).toBe(area.x);
    expect(big.y).toBe(area.y);

    const pinned = shell.openDialog({
      title: 'Offscreen',
      width: 100,
      height: 80,
      x: -30,
      y: -30,
      content: () => new Box(10, 10),
    });
    expect(pinned.x).toBeGreaterThanOrEqual(area.x);
    expect(pinned.y).toBeGreaterThanOrEqual(area.y);
    shell.dispose();
  });
});
