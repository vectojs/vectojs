// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { Entity } from '@vectojs/core';
import { Stack, ScrollView, Text } from '@vectojs/ui';
import { describeEntity } from '../src/model';
import { inspectEntity, layoutControlledProperties } from '../src/inspect';

/**
 * Runtime override versus source-controlled property.
 *
 * Editing `x` on a `Stack`-laid-out child is reverted by the next layout, which
 * reads as the editor being broken rather than the value being owned elsewhere.
 * The parent declares what it controls, so tooling can say so before the user
 * discovers it by watching their change disappear.
 */
class Box extends Entity {
  constructor() {
    super();
    this.width = 20;
    this.height = 10;
  }
  public override render(): void {}
}

describe('layoutControlledProperties', () => {
  it('reports x and y for a Stack child', () => {
    const stack = new Stack({ direction: 'vertical' });
    const child = new Box();
    stack.add(child);
    expect(layoutControlledProperties(child)).toEqual(['x', 'y']);
  });

  it('reports nothing for a root entity with no parent', () => {
    expect(layoutControlledProperties(new Box())).toEqual([]);
  });

  it('reports nothing for a child of a plain container', () => {
    const parent = new Box();
    const child = new Box();
    parent.add(child);
    // A plain Entity does not position its children, so nothing is owned.
    expect(layoutControlledProperties(child)).toEqual([]);
  });

  it('answers per child where a container distinguishes them', () => {
    const view = new ScrollView({ width: 100, height: 100 });
    const child = new Text('hi', { font: '12px sans-serif' });
    view.add(child);
    // ScrollView owns geometry on its internal wrapper, where the scroll offset
    // lives — not on the children a caller adds inside it.
    expect(layoutControlledProperties(child)).toEqual([]);
    const wrapper = (view as unknown as { content: Entity }).content;
    expect(layoutControlledProperties(wrapper)).toEqual(['y', 'width', 'height']);
  });

  it('survives a container whose declaration throws', () => {
    class Hostile extends Entity {
      public override getLayoutControlledProperties(): never {
        throw new Error('nope');
      }
      public override render(): void {}
    }
    const parent = new Hostile();
    const child = new Box();
    parent.add(child);
    // An app-supplied container must not break the inspector.
    expect(layoutControlledProperties(child)).toEqual([]);
  });
});

describe('inspectEntity layoutControlled', () => {
  it('carries the controlled list', () => {
    const stack = new Stack({ direction: 'horizontal' });
    const child = new Box();
    stack.add(child);
    expect(inspectEntity(child).layoutControlled).toEqual(['x', 'y']);
  });

  it('omits the field when nothing is controlled', () => {
    expect('layoutControlled' in inspectEntity(new Box())).toBe(false);
  });
});

describe('describeEntity origin marking', () => {
  it('marks controlled properties and names the owner', () => {
    const stack = new Stack({ direction: 'vertical' });
    const child = new Box();
    stack.add(child);
    const lines = describeEntity(child);
    const geometry = lines.find((l) => l.startsWith('x'))!;
    // The marker sits on the property itself, so the reader sees it while looking
    // at the value rather than in a footnote.
    expect(geometry).toContain('x*');
    expect(geometry).toContain('y*');
    expect(lines.join('\n')).toContain('set by Stack layout');
    expect(lines.join('\n')).toContain('edits revert');
  });

  it('leaves an unowned property unmarked', () => {
    const lines = describeEntity(new Box());
    const geometry = lines.find((l) => l.startsWith('x'))!;
    expect(geometry).not.toContain('x*');
    expect(lines.join('\n')).not.toContain('edits revert');
  });
});
