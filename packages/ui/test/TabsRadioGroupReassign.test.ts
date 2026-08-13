// @vitest-environment jsdom
//
// `tabs`/`options` are reassignable public arrays. Replacing the array (rather
// than mutating it in place) used to desync the a11y hotspot pools: the
// transparent role="tab"/role="radio" hotspots kept describing the OLD list,
// so keyboard focus and AT activation targeted stale labels and ids while the
// canvas painted the new list.
import { describe, expect, it } from 'vitest';
import { Entity } from '@vectojs/core';
import { RadioGroup, Tabs } from '../src/index';

class Panel extends Entity {
  isPointInside(): boolean {
    return false;
  }
  render(): void {}
}

const hotspotsOf = (w: unknown): unknown[] => (w as { _hotspots: unknown[] })._hotspots;
const labelOf = (h: unknown): string =>
  (h as { getA11yAttributes: () => { label?: string } }).getA11yAttributes().label ?? '';

describe('reassigning the public item arrays', () => {
  it('Tabs: a replaced tabs array re-syncs the hotspot pool', () => {
    const tabs = new Tabs({
      width: 400,
      height: 300,
      tabs: [
        { id: 'a', label: 'Alpha', content: new Panel() },
        { id: 'b', label: 'Beta', content: new Panel() },
      ],
    });
    expect(hotspotsOf(tabs)).toHaveLength(2);
    expect(hotspotsOf(tabs).map(labelOf)).toEqual(['Alpha', 'Beta']);

    // Replace the whole array (not mutate in place): the pool must follow.
    tabs.tabs = [
      { id: 'c', label: 'Gamma', content: new Panel() },
      { id: 'd', label: 'Delta', content: new Panel() },
      { id: 'e', label: 'Epsilon', content: new Panel() },
    ];
    expect(hotspotsOf(tabs)).toHaveLength(3);
    expect(hotspotsOf(tabs).map(labelOf)).toEqual(['Gamma', 'Delta', 'Epsilon']);
  });

  it('RadioGroup: a replaced options array re-syncs the hotspot pool (same length)', () => {
    const group = new RadioGroup({
      options: [
        { value: 'light', label: 'Light' },
        { value: 'dark', label: 'Dark' },
      ],
    });
    expect(hotspotsOf(group)).toHaveLength(2);
    expect(hotspotsOf(group).map(labelOf)).toEqual(['Light', 'Dark']);

    // Same length: no pool rebuild, but the labels must follow the new array.
    group.options = [
      { value: 'light', label: 'Light Theme' },
      { value: 'dark', label: 'Dark Theme' },
    ];
    expect(hotspotsOf(group)).toHaveLength(2);
    expect(hotspotsOf(group).map(labelOf)).toEqual(['Light Theme', 'Dark Theme']);
  });

  it('RadioGroup: a replaced options array rebuilds the hotspot pool (new length)', () => {
    const group = new RadioGroup({
      options: [
        { value: 'light', label: 'Light' },
        { value: 'dark', label: 'Dark' },
      ],
    });
    group.options = [
      { value: 'light', label: 'Light Theme' },
      { value: 'dark', label: 'Dark Theme' },
      { value: 'sepia', label: 'Sepia' },
    ];
    expect(hotspotsOf(group)).toHaveLength(3);
    expect(hotspotsOf(group).map(labelOf)).toEqual(['Light Theme', 'Dark Theme', 'Sepia']);
  });
});
