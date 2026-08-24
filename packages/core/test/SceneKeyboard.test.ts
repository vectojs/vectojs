// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';

// Minimal 2D-context mock: jsdom has no canvas backend, so every Scene needs
// this to construct (same pattern as Scene.test.ts).
const mockCtx = {
  scale: vi.fn(),
  clearRect: vi.fn(),
  save: vi.fn(),
  restore: vi.fn(),
  translate: vi.fn(),
  rotate: vi.fn(),
  fillText: vi.fn(),
  measureText: vi.fn(() => ({
    width: 20,
    actualBoundingBoxAscent: 12,
    actualBoundingBoxDescent: 4,
  })),
  beginPath: vi.fn(),
  moveTo: vi.fn(),
  arc: vi.fn(),
  fill: vi.fn(),
  rect: vi.fn(),
  clip: vi.fn(),
  set globalAlpha(_v: number) {},
};
if (typeof HTMLCanvasElement !== 'undefined') {
  HTMLCanvasElement.prototype.getContext = (() => mockCtx) as any;
}

// Stub rAF so scene.start() never enters the real frame loop in these tests.
(globalThis as any).requestAnimationFrame = vi.fn();

import { Entity, KEYBOARD_OWNING_ROLES, Scene, normalizeChord, ownsKeyboard } from '../src';

const liveScenes: Scene[] = [];

function makeScene(): Scene {
  const canvas = document.createElement('canvas');
  const scene = new Scene(canvas);
  liveScenes.push(scene);
  return scene;
}

/** Real bubbling cancelable KeyboardEvent, ready to dispatch from any target. */
function keyEvent(type: 'keydown' | 'keyup', init: KeyboardEventInit = {}): KeyboardEvent {
  return new KeyboardEvent(type, { bubbles: true, cancelable: true, ...init });
}

afterEach(() => {
  // Detach every window keyboard listener a test registered.
  while (liveScenes.length > 0) liveScenes.pop()!.destroy();
});

describe('normalizeChord', () => {
  // Ported from @vectojs/desktop's ShortcutRouter.test.ts after the function
  // was promoted into core.
  it('normalizes string chords', () => {
    expect(normalizeChord('ctrl+shift+n')).toBe('Control+Shift+N');
    expect(normalizeChord('Meta+w')).toBe('Meta+W');
    expect(normalizeChord('Alt+Tab')).toBe('Alt+Tab');
  });

  it('normalizes KeyboardEvent-like objects', () => {
    const ev = {
      ctrlKey: true,
      altKey: false,
      shiftKey: true,
      metaKey: false,
      key: 'n',
    } as KeyboardEvent;
    expect(normalizeChord(ev)).toBe('Control+Shift+N');
  });
});

describe('ownsKeyboard / KEYBOARD_OWNING_ROLES', () => {
  it('never owns for null, body, documentElement, or the scene a11y root', () => {
    expect(ownsKeyboard(null)).toBe(false);
    expect(ownsKeyboard(document.body)).toBe(false);
    expect(ownsKeyboard(document.documentElement)).toBe(false);
    const rootLike = document.createElement('div');
    rootLike.setAttribute('data-vecto-a11y-root', '');
    expect(ownsKeyboard(rootLike)).toBe(false);
  });

  it('always owns for editable elements regardless of role', () => {
    for (const tag of ['input', 'textarea', 'select']) {
      const el = document.createElement(tag);
      expect(ownsKeyboard(el)).toBe(true);
    }
    // jsdom hardcodes `isContentEditable` to false (it does not implement
    // contenteditable), so simulate the browser value on the instance.
    const editable = document.createElement('div');
    Object.defineProperty(editable, 'isContentEditable', { value: true });
    expect(ownsKeyboard(editable)).toBe(true);
    const notEditable = document.createElement('div');
    expect(ownsKeyboard(notEditable)).toBe(false);
  });

  it('owns iff the role attribute is in KEYBOARD_OWNING_ROLES', () => {
    const el = document.createElement('div');
    expect(ownsKeyboard(el)).toBe(false);
    for (const role of ['option', 'listbox', 'textbox', 'searchbox', 'spinbutton']) {
      el.setAttribute('role', role);
      expect(KEYBOARD_OWNING_ROLES.has(role)).toBe(true);
      expect(ownsKeyboard(el)).toBe(true);
    }
    // Union member from INTERACTIVE_A11Y_ROLES.
    el.setAttribute('role', 'slider');
    expect(ownsKeyboard(el)).toBe(true);
    el.setAttribute('role', 'status');
    expect(ownsKeyboard(el)).toBe(false);
  });
});

describe('Scene keyboard channel', () => {
  it('delivers keydown to handlers with correct payload fields (activeElement=body)', () => {
    const scene = makeScene();
    scene.start();
    const seen: any[] = [];
    scene.on('keydown', (e) => seen.push(e));

    document.body.dispatchEvent(keyEvent('keydown', { key: 'a', code: 'KeyA' }));

    expect(seen).toHaveLength(1);
    const e = seen[0];
    expect(e.type).toBe('keydown');
    expect(e.key).toBe('a');
    expect(e.code).toBe('KeyA');
    expect(e.repeat).toBe(false);
    expect(e.ctrlKey).toBe(false);
    expect(e.altKey).toBe(false);
    expect(e.shiftKey).toBe(false);
    expect(e.metaKey).toBe(false);
    expect(e.target).toBe(document.body);
    expect(e.nativeEvent).toBeInstanceOf(KeyboardEvent);
    expect(typeof e.stopPropagation).toBe('function');
    expect(typeof e.preventDefault).toBe('function');
  });

  it('routes keyup through its own channel', () => {
    const scene = makeScene();
    scene.start();
    const downs = vi.fn();
    const ups = vi.fn();
    scene.on('keydown', downs);
    scene.on('keyup', ups);

    document.body.dispatchEvent(keyEvent('keyup', { key: 'a' }));

    expect(ups).toHaveBeenCalledTimes(1);
    expect(downs).not.toHaveBeenCalled();
  });

  it('suppresses auto-repeat and already-defaultPrevented events', () => {
    const scene = makeScene();
    scene.start();
    const handler = vi.fn();
    scene.on('keydown', handler);

    document.body.dispatchEvent(keyEvent('keydown', { key: 'a', repeat: true }));
    const prevented = keyEvent('keydown', { key: 'b' });
    prevented.preventDefault();
    document.body.dispatchEvent(prevented);

    expect(handler).not.toHaveBeenCalled();
  });

  it('a focused <input> blocks ALL keys including modifier chords (gate c is unconditional)', () => {
    const scene = makeScene();
    scene.start();
    const handler = vi.fn();
    const shortcut = vi.fn();
    scene.on('keydown', handler);
    scene.registerShortcut({ chord: 'ctrl+n', handler: shortcut });

    const input = document.createElement('input');
    document.body.appendChild(input);
    try {
      input.focus();
      expect(document.activeElement).toBe(input);

      document.body.dispatchEvent(keyEvent('keydown', { key: 'a' }));
      document.body.dispatchEvent(keyEvent('keydown', { key: 'n', code: 'KeyN', ctrlKey: true }));
    } finally {
      input.blur();
      input.remove();
    }

    expect(handler).not.toHaveBeenCalled();
    expect(shortcut).not.toHaveBeenCalled();
  });

  it('a focused slider-role element blocks arrow keys', () => {
    const scene = makeScene();
    scene.start();
    const handler = vi.fn();
    scene.on('keydown', handler);

    const slider = document.createElement('div');
    slider.setAttribute('role', 'slider');
    slider.setAttribute('tabindex', '0');
    document.body.appendChild(slider);
    try {
      slider.focus();
      expect(document.activeElement).toBe(slider);

      document.body.dispatchEvent(keyEvent('keydown', { key: 'ArrowLeft' }));
      document.body.dispatchEvent(keyEvent('keydown', { key: 'ArrowRight' }));
    } finally {
      slider.blur();
      slider.remove();
    }

    expect(handler).not.toHaveBeenCalled();
  });

  it('an entity keydown handler stopping NATIVE propagation keeps the scene channel silent', () => {
    const scene = makeScene();
    scene.start();

    class SwitchLike extends Entity {
      isPointInside(): boolean {
        return false;
      }
      render(): void {}
      getA11yAttributes() {
        return { tag: 'div' as const, role: 'switch', label: 'Toggle' };
      }
    }
    const sw = new SwitchLike('sw');
    sw.interactive = true;
    sw.width = 40;
    sw.height = 20;
    scene.add(sw);
    (scene as any).syncA11y((scene as any).root);
    const swEl = (scene as any).a11yElements.get('sw') as HTMLElement;

    // The per-node forwarder hands the entity a VectoJSEvent wrapping the
    // native keydown; only stopping the NATIVE event keeps it off the window
    // bubble path (VectoJSEvent.stopPropagation is tree-local by design).
    sw.on('keydown', (e) => {
      (e.nativeEvent as KeyboardEvent | undefined)?.stopPropagation();
    });
    const sceneHandler = vi.fn();
    scene.on('keydown', sceneHandler);

    swEl.dispatchEvent(keyEvent('keydown', { key: 'Enter' }));

    expect(sceneHandler).not.toHaveBeenCalled();
  });

  it('off() removes exactly its handler; unsupported names warn and are rejected', () => {
    const scene = makeScene();
    scene.start();
    const kept = vi.fn();
    const dropped = vi.fn();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      scene.on('keydown', kept);
      scene.on('keydown', dropped);
      document.body.dispatchEvent(keyEvent('keydown', { key: 'x' }));
      expect(kept).toHaveBeenCalledTimes(1);
      expect(dropped).toHaveBeenCalledTimes(1);

      scene.off('keydown', dropped);
      document.body.dispatchEvent(keyEvent('keydown', { key: 'x' }));
      expect(kept).toHaveBeenCalledTimes(2);
      expect(dropped).toHaveBeenCalledTimes(1);

      // Unknown event names: runtime-rejected even though TS narrows them.
      expect((scene as any).on('keypress', kept)).toBe(scene);
      expect(warn).toHaveBeenCalled();
      document.body.dispatchEvent(keyEvent('keydown', { key: 'x' }));
      expect(kept).toHaveBeenCalledTimes(3);
      expect((scene as any).off('keypress', kept)).toBe(scene);
    } finally {
      warn.mockRestore();
    }
  });

  it('listeners survive stop(), attach once despite repeated start(), and die with destroy()', () => {
    const scene = makeScene();
    scene.start();
    scene.start(); // idempotent attach
    scene.stop(); // left attached across stop()
    const handler = vi.fn();
    scene.on('keydown', handler);

    document.body.dispatchEvent(keyEvent('keydown', { key: 'y' }));
    expect(handler).toHaveBeenCalledTimes(1);

    scene.destroy();
    expect(() => scene.off('keydown', handler)).not.toThrow(); // silent no-op
    document.body.dispatchEvent(keyEvent('keydown', { key: 'y' }));
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('registerShortcut matches normalized chords and forwards the payload', () => {
    const scene = makeScene();
    scene.start();
    const handler = vi.fn();
    scene.registerShortcut({ chord: 'ctrl+shift+n', handler });

    document.body.dispatchEvent(
      keyEvent('keydown', { key: 'n', code: 'KeyN', ctrlKey: true, shiftKey: true }),
    );
    expect(handler).toHaveBeenCalledTimes(1);
    const e = handler.mock.calls[0][0];
    expect(e.key).toBe('n');
    expect(e.ctrlKey).toBe(true);
    expect(e.shiftKey).toBe(true);
    expect(e.type).toBe('keydown');

    // Shortcuts never fire on keyup.
    document.body.dispatchEvent(
      keyEvent('keyup', { key: 'n', code: 'KeyN', ctrlKey: true, shiftKey: true }),
    );
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('shortcut registration is alias-tolerant and unregisterShortcut removes it', () => {
    const scene = makeScene();
    scene.start();
    const handler = vi.fn();
    scene.registerShortcut({ chord: 'Ctrl+N', handler });

    document.body.dispatchEvent(keyEvent('keydown', { key: 'n', ctrlKey: true }));
    expect(handler).toHaveBeenCalledTimes(1);

    scene.unregisterShortcut({ chord: 'ctrl + n', handler });
    document.body.dispatchEvent(keyEvent('keydown', { key: 'n', ctrlKey: true }));
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('shortcuts honor the same gates (repeat, defaultPrevented, ownership)', () => {
    const scene = makeScene();
    scene.start();
    const handler = vi.fn();
    scene.registerShortcut({ chord: 'ctrl+k', handler });

    document.body.dispatchEvent(keyEvent('keydown', { key: 'k', ctrlKey: true, repeat: true }));
    const prevented = keyEvent('keydown', { key: 'k', ctrlKey: true });
    prevented.preventDefault();
    document.body.dispatchEvent(prevented);

    const input = document.createElement('input');
    document.body.appendChild(input);
    try {
      input.focus();
      document.body.dispatchEvent(keyEvent('keydown', { key: 'k', ctrlKey: true }));
    } finally {
      input.blur();
      input.remove();
    }

    expect(handler).not.toHaveBeenCalled();
  });
});
