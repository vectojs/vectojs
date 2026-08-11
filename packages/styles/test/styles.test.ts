import { describe, expect, it, vi } from 'vitest';
import type { Entity } from '@vectojs/core';
import { applyStyle, style, type Style } from '../src/index';

type AnyEntity = Entity & Record<string, unknown>;

function stub(fields: Record<string, unknown>): AnyEntity {
  return { scene: null, constructor: { name: 'Stub' }, ...fields } as AnyEntity;
}

function liveScene() {
  return { markDirty: vi.fn() };
}

describe('style()', () => {
  it('returns the object unchanged', () => {
    const s = { backgroundColor: '#2563eb' as const, padding: 12 as const };
    expect(style(s)).toBe(s);
  });
});

describe('applyStyle: geometry keys', () => {
  it('writes bare numbers and px strings as numbers', () => {
    const e = stub({ x: 0, y: 0, width: 10, height: 10, opacity: 1 });
    const { applied } = applyStyle(e, style({ x: 4, y: '8px', width: 100, opacity: 0.5 }));
    expect(e.x).toBe(4);
    expect(e.y).toBe(8);
    expect(e.width).toBe(100);
    expect(e.opacity).toBe(0.5);
    expect(applied).toEqual(['x', 'y', 'width', 'opacity']);
  });

  it('rejects non-px units and percentages', () => {
    const e = stub({ width: 0 });
    expect(() => applyStyle(e, style({ width: '50%' }))).toThrow(/width/);
    expect(() => applyStyle(e, style({ width: '8em' }))).toThrow(/width/);
  });
});

describe('applyStyle: box and text keys', () => {
  it('maps CSS names to entity fields with conversions', () => {
    const e = stub({
      bg: '',
      color: '',
      borderColor: '',
      radius: 0,
      padding: 0,
      font: '',
      lineHeight: 0,
      textAlign: 'left',
    });
    const { applied } = applyStyle(
      e,
      style({
        backgroundColor: '#2563eb',
        color: '#fff',
        borderColor: 'rgba(0,0,0,0.1)',
        borderRadius: '8px',
        padding: 12,
        font: '16px Inter',
        lineHeight: 24,
        textAlign: 'justify',
      }),
    );
    expect(e.bg).toBe('#2563eb');
    expect(e.color).toBe('#fff');
    expect(e.borderColor).toBe('rgba(0,0,0,0.1)');
    expect(e.radius).toBe(8);
    expect(e.padding).toBe(12);
    expect(e.font).toBe('16px Inter');
    expect(e.lineHeight).toBe(24);
    expect(e.textAlign).toBe('justify');
    expect(applied).toEqual([
      'backgroundColor',
      'color',
      'borderColor',
      'borderRadius',
      'padding',
      'font',
      'lineHeight',
      'textAlign',
    ]);
  });

  it('rejects textAlign values ui text does not support', () => {
    const e = stub({ textAlign: 'left' });
    expect(() => applyStyle(e, style({ textAlign: 'center' }))).toThrow(/textAlign/);
    expect(() => applyStyle(e, style({ textAlign: 'right' }))).toThrow(/textAlign/);
  });
});

describe('applyStyle: cross-component skipping', () => {
  it('silently skips keys the entity does not have', () => {
    const e = stub({ color: '#000' }); // no bg/radius/padding
    const { applied } = applyStyle(
      e,
      style({ color: '#111', backgroundColor: '#222', padding: 8 }),
    );
    expect(e.color).toBe('#111');
    expect(e).not.toHaveProperty('bg');
    expect(e).not.toHaveProperty('padding');
    expect(applied).toEqual(['color']);
  });

  it('skips undefined values', () => {
    const e = stub({ x: 0 });
    const { applied } = applyStyle(e, style({ x: 1, y: undefined }));
    expect(e.x).toBe(1);
    expect(applied).toEqual(['x']);
  });
});

describe('applyStyle: layout keys on containers', () => {
  const containerStub = () => stub({ direction: 'vertical', gap: 0, align: 'start', wrap: false });

  it('maps flexDirection/gap/alignItems/flexWrap onto Stack/Flow fields', () => {
    const e = containerStub();
    const { applied } = applyStyle(
      e,
      style({
        display: 'flex',
        flexDirection: 'row',
        gap: '8px',
        alignItems: 'flex-end',
        flexWrap: 'wrap',
      }),
    );
    expect(e.direction).toBe('horizontal');
    expect(e.gap).toBe(8);
    expect(e.align).toBe('end');
    expect(e.wrap).toBe(true);
    expect(applied).toEqual(['display', 'flexDirection', 'gap', 'alignItems', 'flexWrap']);
  });

  it('maps column to vertical and nowrap to false', () => {
    const e = containerStub();
    applyStyle(e, style({ flexDirection: 'column', flexWrap: 'nowrap' }));
    expect(e.direction).toBe('vertical');
    expect(e.wrap).toBe(false);
  });

  it('throws on a non-container entity', () => {
    const e = stub({ textAlign: 'left' });
    expect(() => applyStyle(e, style({ gap: 8 }))).toThrow(/container-only.*Stub/);
    expect(() => applyStyle(e, style({ display: 'flex' }))).toThrow(/container-only.*Stub/);
  });

  it('rejects unknown keyword values', () => {
    const e = containerStub();
    expect(() => applyStyle(e, style({ alignItems: 'stretch' }))).toThrow(/alignItems/);
    expect(() => applyStyle(e, style({ flexDirection: 'row-reverse' }))).toThrow(/flexDirection/);
    expect(() => applyStyle(e, style({ display: 'block' }))).toThrow(/display/);
  });
});

describe('applyStyle: errors', () => {
  it('throws on unknown style properties', () => {
    const e = stub({});
    expect(() => applyStyle(e, style({ position: 'absolute' } as unknown as Style))).toThrow(
      /unknown style property 'position'/,
    );
  });
});

describe('applyStyle: dirty signalling', () => {
  it('marks the scene dirty once when keys were applied', () => {
    const scene = liveScene();
    const e = stub({ x: 0, y: 0, bg: '' });
    e.scene = scene as never;
    applyStyle(e, style({ x: 5, backgroundColor: '#000' }));
    expect(scene.markDirty).toHaveBeenCalledTimes(1);
  });

  it('does not mark dirty when every key was skipped', () => {
    const scene = liveScene();
    const e = stub({ x: 0 });
    e.scene = scene as never;
    applyStyle(e, style({ backgroundColor: '#000', padding: 4 }));
    expect(scene.markDirty).not.toHaveBeenCalled();
  });

  it('does not mark dirty when the entity has no scene', () => {
    const e = stub({ x: 0 });
    applyStyle(e, style({ x: 5 }));
    expect(e.x).toBe(5);
  });
});
