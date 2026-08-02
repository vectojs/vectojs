// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { RadioGroup } from '../src/RadioGroup';
import { Tabs } from '../src/Tabs';
import { UIComponent } from '../src/UIComponent';

/**
 * `RadioGroup` and `Tabs` project a container node (`radiogroup` / `tablist`)
 * alongside the per-option nodes. The options were always nameable; the
 * containers were not, so every group on a screen announced with the same
 * generic string. These tests pin both the override and the default, since the
 * default is what existing consumers rely on.
 */
describe('group container accessible names', () => {
  const options = [
    { value: 'a', label: 'Option A' },
    { value: 'b', label: 'Option B' },
  ];

  describe('RadioGroup', () => {
    it('projects the supplied label on the radiogroup container', () => {
      const group = new RadioGroup({ options, label: 'Distribution' });

      const attrs = group.getA11yAttributes();

      expect(attrs.role).toBe('radiogroup');
      expect(attrs.label).toBe('Distribution');
    });

    it('falls back to a generic name when no label is supplied', () => {
      const group = new RadioGroup({ options });

      expect(group.getA11yAttributes().label).toBe('Radio group');
    });

    it('keeps each option nameable independently of the group', () => {
      const group = new RadioGroup({ options, label: 'Distribution' });

      // The option hotspots are children; the group name must not overwrite
      // them, or a user loses the ability to tell the choices apart.
      const optionNames = group.children
        .map((child) => child.getA11yAttributes?.())
        .filter((attrs) => attrs?.role === 'radio')
        .map((attrs) => attrs?.label);

      expect(optionNames).toEqual(['Option A', 'Option B']);
    });

    it('reflects a label reassigned after construction', () => {
      const group = new RadioGroup({ options, label: 'Distribution' });

      group.label = 'Presets';

      expect(group.getA11yAttributes().label).toBe('Presets');
    });

    it('distinguishes two groups that share identical options', () => {
      const first = new RadioGroup({ options, label: 'Distribution' });
      const second = new RadioGroup({ options, label: 'Track profile' });

      // The defect this fixes: without a group label these two are
      // indistinguishable to a screen reader despite selecting different things.
      expect(first.getA11yAttributes().label).not.toBe(second.getA11yAttributes().label);
    });
  });

  describe('Tabs', () => {
    const makeTabs = () => [
      { id: 'one', label: 'Videos', content: new UIComponent() },
      { id: 'two', label: 'Throughput', content: new UIComponent() },
    ];

    it('projects the supplied label on the tablist container', () => {
      const bar = new Tabs({
        width: 300,
        height: 200,
        tabs: makeTabs(),
        label: 'Laboratory sections',
      });

      const attrs = bar.getA11yAttributes();

      expect(attrs.role).toBe('tablist');
      expect(attrs.label).toBe('Laboratory sections');
    });

    it('falls back to a generic name when no label is supplied', () => {
      const bar = new Tabs({ width: 300, height: 200, tabs: makeTabs() });

      expect(bar.getA11yAttributes().label).toBe('Tab switching panel');
    });

    it('reflects a label reassigned after construction', () => {
      const bar = new Tabs({
        width: 300,
        height: 200,
        tabs: makeTabs(),
        label: 'Laboratory sections',
      });

      bar.label = 'Inspector sections';

      expect(bar.getA11yAttributes().label).toBe('Inspector sections');
    });
  });
});
