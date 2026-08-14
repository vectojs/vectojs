import { describe, expect, it } from 'vitest';
import { Entity } from '@vectojs/core';
import { AppRegistry } from '../src';

class Leaf extends Entity {
  override render(): void {}
}

describe('AppRegistry', () => {
  it('registers, lists, and looks up apps', () => {
    const reg = new AppRegistry();
    expect(reg.size).toBe(0);
    reg.register({ id: 'clock', title: 'Clock', create: () => new Leaf() });
    expect(reg.has('clock')).toBe(true);
    expect(reg.get('clock')?.title).toBe('Clock');
    expect(reg.list().map((a) => a.id)).toEqual(['clock']);
  });

  it('replaces on re-register and unregisters', () => {
    const reg = new AppRegistry([{ id: 'a', title: 'A', create: () => new Leaf() }]);
    reg.register({ id: 'a', title: 'A2', create: () => new Leaf() });
    expect(reg.get('a')?.title).toBe('A2');
    expect(reg.unregister('a')).toBe(true);
    expect(reg.has('a')).toBe(false);
    expect(reg.unregister('a')).toBe(false);
  });

  it('rejects incomplete definitions', () => {
    const reg = new AppRegistry();
    expect(() => reg.register({ id: '', title: 'x', create: () => new Leaf() })).toThrow();
    expect(() => reg.register({ id: 'x', title: 'X', create: undefined as never })).toThrow(
      /create/,
    );
  });
});
