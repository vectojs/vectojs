// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { normalizeChord, ShortcutRouter } from '../src';

describe('normalizeChord', () => {
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

describe('ShortcutRouter', () => {
  it('looks up actions by chord', () => {
    const r = new ShortcutRouter({
      'Control+n': { type: 'open-app', appId: 'notes' },
      'Meta+w': { type: 'close-focused' },
    });
    expect(r.lookup('ctrl+n')).toEqual({ type: 'open-app', appId: 'notes' });
    expect(r.lookup('Meta+w')).toEqual({ type: 'close-focused' });
    expect(r.lookup('Alt+x')).toBeUndefined();
  });

  it('dispatches on keydown when attached', () => {
    const handler = vi.fn();
    const r = new ShortcutRouter({
      'Control+n': { type: 'open-app', appId: 'notes' },
    });
    r.setHandler(handler);
    r.attach();
    const ev = new KeyboardEvent('keydown', {
      key: 'n',
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    document.dispatchEvent(ev);
    expect(handler).toHaveBeenCalledWith({ type: 'open-app', appId: 'notes' }, 'Control+N');
    expect(ev.defaultPrevented).toBe(true);
    r.detach();
  });
});
