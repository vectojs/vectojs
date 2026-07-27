// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { Entity, type DevtoolsDescriptor } from '@vectojs/core';
import { describeEntity } from '../src/model';
import { inspectEntity } from '../src/inspect';

/**
 * The `getDevtoolsDescriptor()` protocol.
 *
 * Before it, the inspector could only show generic `Entity` properties, so
 * everything that makes a component a component was invisible: `Input.value`,
 * `Slider.min`/`max`, `ScrollView.scrollTop`, `VirtualList.visibleRange`. The
 * alternative — DevTools carrying a table of component types — inverts the
 * dependency and breaks under minified builds where `constructor.name` is
 * unreliable, so entities describe themselves instead.
 */
class Plain extends Entity {
  public override render(): void {}
}

class Described extends Entity {
  public override render(): void {}
  public override getDevtoolsDescriptor(): DevtoolsDescriptor {
    return {
      kind: 'Described',
      devtoolsKey: 'row-42',
      groups: [
        {
          label: 'State',
          fields: [
            { label: 'count', value: 7 },
            { label: 'ratio', value: 0.5, hint: 'normalised', readOnly: true },
            { label: 'range', value: [3, 9] },
            { label: 'enabled', value: true },
            { label: 'nothing', value: null },
            { label: 'pairs', value: { a: 1, b: 2 } },
          ],
        },
      ],
      notes: ['A caveat worth surfacing.'],
    };
  }
}

class Throwing extends Entity {
  public override render(): void {}
  public override getDevtoolsDescriptor(): DevtoolsDescriptor {
    throw new Error('descriptor is broken');
  }
}

describe('getDevtoolsDescriptor protocol', () => {
  it('defaults to null so existing entities opt out', () => {
    expect(new Plain().getDevtoolsDescriptor()).toBeNull();
  });

  it('omits the descriptor field entirely when an entity provides none', () => {
    const info = inspectEntity(new Plain());
    expect('descriptor' in info).toBe(false);
  });

  it('carries the descriptor through inspectEntity', () => {
    const info = inspectEntity(new Described());
    expect(info.descriptor?.kind).toBe('Described');
    expect(info.descriptor?.groups[0]?.fields[0]).toEqual({
      label: 'count',
      value: 7,
    });
    expect(info.descriptor?.devtoolsKey).toBe('row-42');
  });

  it('stays JSON-serializable', () => {
    // DevTools serializes descriptors to render a panel, write a snapshot, and
    // cross a postMessage bridge. A value that cannot survive a round trip is a
    // bug in the descriptor, not a limitation of the panel.
    const info = inspectEntity(new Described());
    expect(JSON.parse(JSON.stringify(info)).descriptor).toEqual(info.descriptor);
  });

  it('survives a throwing descriptor rather than taking the inspector down', () => {
    // A debug tool that crashes on the entity you are trying to debug is worse
    // than one missing a field.
    const info = inspectEntity(new Throwing());
    expect(info.type).toBe('Throwing');
    expect(info.descriptor).toBeUndefined();
  });
});

describe('describeEntity descriptor rendering', () => {
  it('keeps the six generic lines for an entity without a descriptor', () => {
    const lines = describeEntity(new Plain());
    expect(lines.length).toBe(6);
    expect(lines[0]).toContain('Plain');
  });

  it('appends grouped descriptor rows after the generic ones', () => {
    const lines = describeEntity(new Described());
    expect(lines.length).toBeGreaterThan(6);
    expect(lines).toContain('— Described —');
    expect(lines).toContain('State:');
    expect(lines.some((l) => l.includes('count') && l.includes('7'))).toBe(true);
  });

  it('marks read-only fields so an edit is not invited', () => {
    const lines = describeEntity(new Described());
    const ratio = lines.find((l) => l.includes('ratio'))!;
    const count = lines.find((l) => l.includes('count'))!;
    // `ratio` is read-only, `count` is not. Without the marker a reader edits a
    // derived value and watches it silently revert.
    expect(ratio).toContain('\u00b7');
    expect(count).not.toContain('\u00b7');
  });

  it('formats arrays, records, booleans and null readably', () => {
    const lines = describeEntity(new Described()).join('\n');
    expect(lines).toContain('[3, 9]');
    expect(lines).toContain('a=1 b=2');
    expect(lines).toContain('true');
    expect(lines).toContain('null');
  });

  it('renders notes with a marker', () => {
    const lines = describeEntity(new Described());
    expect(lines.some((l) => l.startsWith('! A caveat'))).toBe(true);
  });

  it('reports a throwing descriptor inline instead of throwing', () => {
    const lines = describeEntity(new Throwing());
    expect(lines).toContain('— descriptor threw —');
    expect(lines[0]).toContain('Throwing');
  });

  it('caps descriptor output so it cannot overflow the panel rows', () => {
    class Huge extends Entity {
      public override render(): void {}
      public override getDevtoolsDescriptor(): DevtoolsDescriptor {
        return {
          kind: 'Huge',
          groups: Array.from({ length: 20 }, (_, g) => ({
            label: `group${g}`,
            fields: Array.from({ length: 20 }, (_, f) => ({
              label: `f${f}`,
              value: f,
            })),
          })),
        };
      }
    }
    const lines = describeEntity(new Huge());
    // Six generic + the kind header + a bounded descriptor budget. The panel
    // allocates a fixed number of rows, so an unbounded descriptor would silently
    // drop whichever fields landed last with no indication.
    expect(lines.length).toBeLessThanOrEqual(6 + 1 + 12);
  });
});
