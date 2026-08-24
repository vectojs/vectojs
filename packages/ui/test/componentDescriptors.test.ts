// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { Input } from '../src/Input';
import { ScrollView } from '../src/ScrollView';
import { Slider } from '../src/Slider';
import { VirtualList } from '../src/VirtualList';
import { Text } from '../src/Text';

/**
 * Component descriptors, exercised against the real components rather than
 * synthetic stand-ins.
 *
 * The point of the protocol is to expose state a generic inspector cannot reach —
 * mostly private fields — so these tests assert on the values a developer would
 * actually be debugging with, and on the notes that fire for genuinely wrong
 * states.
 */
describe('Slider descriptor', () => {
  it('reports range, step and the normalised thumb position', () => {
    const slider = new Slider({ min: 0, max: 200, value: 50, step: 10 });
    const d = slider.getDevtoolsDescriptor();
    expect(d.kind).toBe('Slider');
    const fields = new Map(d.groups[0]!.fields.map((f) => [f.label, f.value]));
    expect(fields.get('value')).toBe(50);
    expect(fields.get('max')).toBe(200);
    // 0.25 is what the renderer actually uses; the raw value alone does not say
    // where the thumb sits.
    expect(fields.get('normalized')).toBe(0.25);
  });

  it('flags a value that is not on a step boundary', () => {
    // Construction snaps onto the grid (#654), so an off-step value can only
    // appear via a direct field write afterwards — the descriptor still flags
    // it because keyboard/drag will snap it on next interaction.
    const slider = new Slider({ min: 0, max: 100, value: 33, step: 10 });
    expect(slider.value).toBe(30); // snapped at construction
    expect(slider.getDevtoolsDescriptor().notes).toBeUndefined();

    slider.value = 33; // raw external write
    expect(slider.getDevtoolsDescriptor().notes?.[0]).toContain('not on a step boundary');
  });

  it('says nothing when the value is on a step', () => {
    const slider = new Slider({ min: 0, max: 100, value: 30, step: 10 });
    expect(slider.getDevtoolsDescriptor().notes).toBeUndefined();
  });
});

describe('Input descriptor', () => {
  it('exposes selection offsets and the selected substring', () => {
    const input = new Input({ value: 'hello world' });
    input.selectionStart = 6;
    input.selectionEnd = 11;
    const d = input.getDevtoolsDescriptor();
    const selection = d.groups.find((g) => g.label === 'Selection')!;
    const fields = new Map(selection.fields.map((f) => [f.label, f.value]));
    // A caret at the right pixel but the wrong UTF-16 offset looks correct until
    // the next edit lands in the wrong place, so both are surfaced.
    expect(fields.get('selection')).toEqual([6, 11]);
    expect(fields.get('selectedText')).toBe('world');
  });

  it('reports an empty selected string for a collapsed caret', () => {
    const input = new Input({ value: 'abc' });
    input.selectionStart = 2;
    input.selectionEnd = 2;
    const fields = new Map(
      input
        .getDevtoolsDescriptor()
        .groups.find((g) => g.label === 'Selection')!
        .fields.map((f) => [f.label, f.value]),
    );
    expect(fields.get('selectedText')).toBe('');
  });

  it('warns when a required field is empty', () => {
    const input = new Input({ value: '', required: true });
    expect(input.getDevtoolsDescriptor().notes?.[0]).toContain('Required and empty');
  });

  it('carries validation state', () => {
    const input = new Input({ value: 'x', required: true, invalid: true });
    const fields = new Map(
      input
        .getDevtoolsDescriptor()
        .groups.find((g) => g.label === 'Validation')!
        .fields.map((f) => [f.label, f.value]),
    );
    expect(fields.get('required')).toBe(true);
    expect(fields.get('invalid')).toBe(true);
  });
});

describe('ScrollView descriptor', () => {
  it('separates the live spring position from its target', () => {
    const view = new ScrollView({ width: 100, height: 100 });
    const child = new Text('x', { font: '12px sans-serif' });
    child.height = 400;
    view.add(child);
    view.updateContentSize();
    view.scrollTo(50);

    const fields = new Map(
      view
        .getDevtoolsDescriptor()
        .groups.find((g) => g.label === 'Scroll')!
        .fields.map((f) => [f.label, f.value]),
    );
    // targetTop moves immediately; scrollTop follows the spring. Seeing only one
    // makes a mid-animation offset indistinguishable from a stuck one.
    expect(fields.get('targetTop')).toBe(50);
    expect(fields.get('maxScroll')).toBeGreaterThan(0);
  });

  it('notes when content fits and scrolling is a no-op', () => {
    const view = new ScrollView({ width: 100, height: 300 });
    const child = new Text('x', { font: '12px sans-serif' });
    child.height = 20;
    view.add(child);
    view.updateContentSize();
    expect(view.getDevtoolsDescriptor().notes?.[0]).toContain('fits the viewport');
  });
});

describe('VirtualList descriptor', () => {
  const makeList = (count: number) =>
    new VirtualList<number>({
      width: 200,
      height: 100,
      items: Array.from({ length: count }, (_, i) => i),
      estimatedRowHeight: 20,
      renderItem: (item) => new Text(`row ${item}`, { font: '12px sans-serif' }),
    });

  it('reports the mounted window against the total row count', () => {
    const list = makeList(1000);
    const d = list.getDevtoolsDescriptor();
    const fields = new Map(
      d.groups.find((g) => g.label === 'Virtualization')!.fields.map((f) => [f.label, f.value]),
    );
    expect(fields.get('totalRows')).toBe(1000);
    // The whole point of the component: a 1000-row list must not mount 1000 rows.
    expect(Number(fields.get('mountedFraction'))).toBeLessThan(100);
    expect(Array.isArray(fields.get('visibleRange'))).toBe(true);
  });

  it('distinguishes measured rows from estimated ones', () => {
    const list = makeList(50);
    const fields = new Map(
      list
        .getDevtoolsDescriptor()
        .groups.find((g) => g.label === 'Measurement')!
        .fields.map((f) => [f.label, f.value]),
    );
    expect(fields.get('estimatedRowHeight')).toBe(20);
    // totalHeight mixes real and estimated heights, so it is approximate until
    // every row has been scrolled into view — the note below says so.
    expect(Number(fields.get('totalHeight'))).toBeGreaterThan(0);
  });

  it('notes that geometry is approximate while rows remain unmeasured', () => {
    const list = makeList(50);
    expect(list.getDevtoolsDescriptor().notes?.[0]).toContain('estimated height');
  });

  it('exposes scroll and drag state', () => {
    const list = makeList(50);
    const fields = new Map(
      list
        .getDevtoolsDescriptor()
        .groups.find((g) => g.label === 'Scroll')!
        .fields.map((f) => [f.label, f.value]),
    );
    expect(fields.get('dragging')).toBe(false);
    expect(fields.get('scrollY')).toBe(0);
  });
});
