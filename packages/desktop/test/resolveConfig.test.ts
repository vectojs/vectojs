import { describe, expect, it } from 'vitest';
import { Entity } from '@vectojs/core';
import { DEFAULT_DESKTOP_TOKENS, MemoryVfs, resolveConfig } from '../src';

class Leaf extends Entity {
  constructor() {
    super();
    this.width = 10;
    this.height = 10;
  }
  override isPointInside(): boolean {
    return false;
  }
  override render(): void {}
}

describe('resolveConfig', () => {
  it('applies default tokens and empty apps', () => {
    const cfg = resolveConfig();
    expect(cfg.apps).toEqual([]);
    expect(cfg.theme['desktop-wallpaper']).toBe(DEFAULT_DESKTOP_TOKENS['desktop-wallpaper']);
    expect(cfg.desktop.wallpaper).toBe(DEFAULT_DESKTOP_TOKENS['desktop-wallpaper']);
    expect(cfg.desktop.taskbarHeight).toBe(40);
    expect(cfg.desktop.displays).toEqual([]);
    expect(cfg.shortcuts).toEqual({});
    expect(cfg.vfs).toBeNull();
  });

  it('merges theme overrides without dropping defaults', () => {
    const cfg = resolveConfig({ theme: { 'desktop-focus-ring': '#f00' } });
    expect(cfg.theme['desktop-focus-ring']).toBe('#f00');
    expect(cfg.theme['desktop-window-bg']).toBe(DEFAULT_DESKTOP_TOKENS['desktop-window-bg']);
  });

  it('registers apps with default single-instance policy', () => {
    const app = {
      id: 'about',
      title: 'About',
      create: () => new Leaf(),
    };
    const cfg = resolveConfig({ apps: [app] });
    expect(cfg.apps[0]!.instances).toBe('single');
    expect(() => resolveConfig({ apps: [app, { ...app }] })).toThrow(/duplicate/);
  });

  it('validates displays and shortcuts', () => {
    const cfg = resolveConfig({
      desktop: {
        displays: [
          { id: 'a', x: 0, y: 0, width: 800, height: 600 },
          { id: 'b', x: 800, y: 0, width: 800, height: 600 },
        ],
        wallpaperImage: 'https://example.com/bg.png',
      },
      shortcuts: {
        'Control+n': { type: 'open-app', appId: 'about' },
        'Meta+w': { type: 'close-focused' },
      },
      vfs: new MemoryVfs(),
    });
    expect(cfg.desktop.displays).toHaveLength(2);
    expect(cfg.desktop.wallpaperImage).toBe('https://example.com/bg.png');
    expect(cfg.shortcuts['Control+n']).toEqual({
      type: 'open-app',
      appId: 'about',
    });
    expect(cfg.vfs).toBeInstanceOf(MemoryVfs);

    expect(() =>
      resolveConfig({
        desktop: { displays: [{ id: 'a', x: 0, y: 0, width: 0, height: 10 }] },
      }),
    ).toThrow(/positive/);
    expect(() =>
      resolveConfig({ shortcuts: { 'Control+x': { type: 'open-app', appId: '' } } }),
    ).toThrow(/appId/);
  });

  it('rejects malformed apps and non-object input', () => {
    expect(() => resolveConfig(null as never)).toThrow(/object/);
    expect(() =>
      resolveConfig({ apps: [{ id: '', title: 'x', create: () => new Leaf() }] }),
    ).toThrow(/id/);
  });
});
