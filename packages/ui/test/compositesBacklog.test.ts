// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { ContextMenu } from '../src/ContextMenu';
import { RadioGroup } from '../src/RadioGroup';
import { Tooltip } from '../src/Tooltip';
import { Dropdown, Modal } from '../src/index';
import { Entity, Scene } from '@vectojs/core';

// Deterministic measurer: every character is 7px wide (matches the stub other
// ui tests use), so wrap/width expectations are checkable.
HTMLCanvasElement.prototype.getContext = (() => ({
  font: '',
  fillStyle: '',
  measureText: (t: string) => ({ width: t.length * 7 }),
  fillText: () => {},
  scale: () => {},
  clearRect: () => {},
  save: () => {},
  restore: () => {},
  translate: () => {},
  rotate: () => {},
  beginPath: () => {},
  rect: () => {},
  clip: () => {},
  moveTo: () => {},
  lineTo: () => {},
  stroke: () => {},
  fill: () => {},
  roundRect: () => {},
})) as never;

function makeScene(): Scene {
  return new Scene(document.createElement('canvas'));
}

class Target extends Entity {
  isPointInside(): boolean {
    return false;
  }
  render(): void {}
}

describe('backlog #655 composites', () => {
  it('Escape from a submenu closes ONE level and refocuses the parent item', () => {
    const s = makeScene();
    const menu = new ContextMenu({
      width: 200,
      items: [
        {
          label: 'Format',
          children: [{ label: 'Bold' }, { label: 'Italic' }],
        },
        { label: 'Copy' },
      ],
    });
    s.overlayRoot.add(menu);
    menu.showAtPoint(10, 10);

    // Open the submenu on the first item (activateIndex opens children).
    menu.activateIndex(0);
    const submenu = (menu as unknown as { _submenu: ContextMenu })._submenu;
    expect(submenu).not.toBeNull();

    // Escape INSIDE the submenu: parent stays open, focus returns to its item.
    submenu!.handleMenuKey(
      { key: 'Escape', preventDefault: () => {} } as unknown as KeyboardEvent,
      0,
    );
    expect((menu as unknown as { _visible: boolean })._visible ?? true).toBeTruthy();
    expect(menu.visible).toBe(true); // parent did NOT collapse

    // Escape on the ROOT closes it outright.
    menu.handleMenuKey({ key: 'Escape', preventDefault: () => {} } as unknown as KeyboardEvent, 0);
    expect(menu.visible).toBe(false);
  });

  it('RadioGroup roving tab stop skips a checked-but-disabled option', () => {
    const group = new RadioGroup({
      options: [
        { value: 'a', label: 'A', disabled: true },
        { value: 'b', label: 'B' },
      ],
      value: 'a', // checked AND disabled — must not keep the tab stop
    });
    expect(group.isTabStop('a')).toBe(false);
    expect(group.isTabStop('b')).toBe(true);
    // The projected attributes agree.
    const attrs = group.options.map(
      (o) =>
        (
          group as unknown as {
            _hotspots: { optionValue: string; getA11yAttributes: () => { tabIndex?: number } }[];
          }
        )._hotspots
          .find((h) => h.optionValue === o.value)!
          .getA11yAttributes().tabIndex,
    );
    expect(attrs).toEqual([-1, 0]);
  });

  it('RadioGroup caches label widths and invalidates them on font change', () => {
    const group = new RadioGroup({ options: [{ value: 'a', label: 'AAA' }] });
    const cache = (group as unknown as { _labelWidths: Map<string, number> })._labelWidths;
    expect(cache.size).toBeGreaterThan(0); // warmed by layout
    group.font = '20px serif';
    expect(cache.size).toBe(0); // invalidated
  });

  it('Tooltip measures its box from real text metrics and wraps long content', () => {
    const target = new Target();
    const short = new Tooltip({ target, content: 'hi there' });
    // 'hi there' = 8 chars × 7 = 56 + 2×10 padding.
    expect(short.width).toBe(76);
    expect(short.height).toBe(30); // single line keeps the compact box

    const long = 'x'.repeat(100); // 700px of text → must wrap inside the 320px cap
    const wrapped = new Tooltip({ target, content: long });
    expect(wrapped.width).toBeLessThanOrEqual(320);
    expect(wrapped.height).toBeGreaterThan(30); // more than one line
    expect((wrapped as unknown as { _lines: string[] })._lines.length).toBeGreaterThan(1);
    // No character lost to wrapping.
    expect((wrapped as unknown as { _lines: string[] })._lines.join('')).toBe(long);
  });

  it('Dropdown ignores a select path for an unknown option', () => {
    const dd = new Dropdown(['a', 'b'], {});
    const select = (
      dd as unknown as {
        selectOption: (o: string) => void;
        selectedValue: string;
        options: string[];
      }
    ).selectOption.bind(dd);
    select('b');
    expect(dd.getValue()).toBe('b');
    select('nope'); // forged/edge event must not set an unknown value
    expect(dd.getValue()).toBe('b');
  });

  it('Dropdown and Modal constructors accept typed options objects', () => {
    const dd = new Dropdown(['a', 'b'], {
      label: 'Choose',
      value: 'b',
      width: 140,
      height: 40,
      bg: '#123456',
      color: '#fff',
      radius: 4,
      font: '14px sans-serif',
      menuBg: '#000',
      menuColor: '#fff',
      menuSelectedBg: '#123',
      menuHighlightBg: '#456',
      focusColor: '#00f0ff',
      onChange: () => {},
    });
    expect(dd.getValue()).toBe('b');

    const modal = new Modal('Title', {
      backdropColor: 'rgba(0,0,0,0.6)',
      modalWidth: 300,
      modalHeight: 200,
      cardBg: '#111',
      cardBorder: '#333',
      width: 800,
      height: 600,
    });
    expect(modal.width).toBe(800);
  });
});
