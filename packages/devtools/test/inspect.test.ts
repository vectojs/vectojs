import { describe, it, expect } from 'vitest';
import { Entity } from '@vectojs/core';
import { inspectEntity, entityPath, textPreviewOf } from '../src/inspect';

class Box extends Entity {
  constructor(id: string, w = 0, h = 0) {
    super(id);
    this.width = w;
    this.height = h;
  }
  isPointInside(): boolean {
    return false;
  }
  render(): void {}
}

class Lbl extends Box {
  public text = 'hello world';
}

class Field extends Box {
  public value = 'typed input';
}

describe('entityPath', () => {
  it('renders the ancestor chain with the tree top as Scene', () => {
    const root = new Box('root');
    const card = new Box('card', 100, 40);
    const label = new Lbl('label', 80, 20);
    card.add(label);
    root.add(card);

    expect(entityPath(label)).toBe('Scene > Box#card > Lbl#label');
    expect(entityPath(root)).toBe('Scene');
  });
});

describe('textPreviewOf', () => {
  it('duck-types .text, falls back to .value, and truncates at 80 chars', () => {
    expect(textPreviewOf(new Lbl('l'))).toBe('hello world');
    expect(textPreviewOf(new Field('f'))).toBe('typed input');
    expect(textPreviewOf(new Box('b'))).toBeUndefined();

    const long = new Lbl('long');
    long.text = 'x'.repeat(100);
    expect(textPreviewOf(long)).toBe(`${'x'.repeat(80)}…`);
  });
});

describe('inspectEntity', () => {
  it('reports complete structured geometry and state', () => {
    const root = new Box('root');
    const e = new Box('e', 30, 10);
    e.setPosition(5.126, 6);
    e.opacity = 0.5;
    e.interactive = true;
    e.clipChildren = true;
    e.add(new Box('kid'));
    root.add(e);

    const info = inspectEntity(e);
    expect(info.id).toBe('e');
    expect(info.type).toBe('Box');
    expect(info.path).toBe('Scene > Box#e');
    expect(info.x).toBe(5.13); // rounded to 2dp
    expect(info.width).toBe(30);
    expect(info.opacity).toBe(0.5);
    expect(info.interactive).toBe(true);
    expect(info.clipChildren).toBe(true);
    expect(info.childCount).toBe(1);
    expect(info.animating).toBe(false);
    expect(info.worldBounds).toEqual({ x: 5.13, y: 6, width: 30, height: 10 });
    expect(info.worldTransform.e).toBe(5.13);
    expect(info.text).toBeUndefined();
    expect(JSON.parse(JSON.stringify(info))).toEqual(info);
  });

  it('includes the text preview for text-bearing entities', () => {
    const info = inspectEntity(new Lbl('l', 80, 20));
    expect(info.text).toBe('hello world');
  });
});
