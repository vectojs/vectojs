import { describe, expect, it } from 'vitest';
import { Entity } from '@vectojs/core';
import { DEFAULT_DESKTOP_TOKENS, resolveConfig } from '../src';

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
    expect(cfg.shortcuts).toEqual({});
  });

  it('merges theme overrides without dropping defaults', () => {
    const cfg = resolveConfig({ theme: { 'desktop-focus-ring': '#f00' } });
    expect(cfg.theme['desktop-focus-ring']).toBe('#f00');
    expect(cfg.theme['desktop-window-bg']).toBe(DEFAULT_DESKTOP_TOKENS['desktop-window-bg']);
  });

  it('registers apps and rejects duplicates', () => {
    const app = {
      id: 'about',
      title: 'About',
      create: () => new Leaf(),
    };
    const cfg = resolveConfig({ apps: [app] });
    expect(cfg.apps).toHaveLength(1);
    expect(() => resolveConfig({ apps: [app, { ...app }] })).toThrow(/duplicate/);
  });

  it('rejects malformed apps and non-object input', () => {
    expect(() => resolveConfig(null as never)).toThrow(/object/);
    expect(() =>
      resolveConfig({ apps: [{ id: '', title: 'x', create: () => new Leaf() }] }),
    ).toThrow(/id/);
    expect(() =>
      resolveConfig({
        apps: [{ id: 'a', title: 'A', create: null as never }],
      }),
    ).toThrow(/create/);
  });
});
