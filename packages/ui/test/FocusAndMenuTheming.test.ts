// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Button } from '../src/Button';
import { Checkbox } from '../src/Checkbox';
import { Dropdown } from '../src/Dropdown';
import { Slider } from '../src/Slider';
import { Toggle } from '../src/Toggle';

/**
 * Records every stroke/fill color a component paints, so a focus ring or a menu
 * row can be asserted by the color that actually reached the renderer rather
 * than by reading the property back.
 */
function recordingRenderer() {
  const strokes: Array<{ color: string; lineWidth?: number }> = [];
  const fills: string[] = [];
  const r = {
    strokes,
    fills,
    save: vi.fn(),
    restore: vi.fn(),
    translate: vi.fn(),
    beginPath: vi.fn(),
    closePath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    rect: vi.fn(),
    roundRect: vi.fn(),
    arc: vi.fn(),
    clip: vi.fn(),
    measureText: vi.fn(() => ({ width: 10 })),
    fillText: vi.fn(),
    fill: vi.fn((color: string) => {
      fills.push(color);
    }),
    stroke: vi.fn((color: string, lineWidth?: number) => {
      strokes.push({ color, lineWidth });
    }),
  };
  return r;
}

/**
 * Attaches a minimal fake scene. `forcedColors` is read off it during render,
 * and `Dropdown.openMenu` mounts its menu through `showOverlay`.
 */
function attachScene(node: unknown, forcedColors = false) {
  const markDirty = vi.fn();
  const overlays: unknown[] = [];
  (node as { _scene: unknown })._scene = {
    markDirty,
    forcedColors,
    width: 800,
    height: 600,
    showOverlay: (overlay: unknown) => {
      overlays.push(overlay);
    },
    hideOverlay: (overlay: unknown) => {
      const i = overlays.indexOf(overlay);
      if (i >= 0) overlays.splice(i, 1);
    },
  };
  return markDirty;
}

beforeEach(() => {
  // Components measure text during render; jsdom has no 2D context by default.
  HTMLCanvasElement.prototype.getContext = vi.fn(() => ({
    measureText: () => ({ width: 10 }),
    font: '',
  })) as unknown as typeof HTMLCanvasElement.prototype.getContext;
});

describe('Button focusColor', () => {
  it('defaults to the cyan ring so existing themes are unchanged', () => {
    const button = new Button('OK');
    expect(button.focusColor).toBe('#00f0ff');
  });

  it('strokes the configured color when focused', () => {
    const button = new Button('OK', { focusColor: '#ff7e5f' });
    attachScene(button);
    button.focused = true;

    const r = recordingRenderer();
    button.render(r as never);

    expect(r.strokes.some((s) => s.color === '#ff7e5f')).toBe(true);
    expect(r.strokes.some((s) => s.color === '#00f0ff')).toBe(false);
  });

  it('does not stroke a focus ring while unfocused', () => {
    const button = new Button('OK', { focusColor: '#ff7e5f' });
    attachScene(button);

    const r = recordingRenderer();
    button.render(r as never);

    expect(r.strokes.some((s) => s.color === '#ff7e5f')).toBe(false);
  });

  it('yields to the system Highlight color under forced colors', () => {
    const button = new Button('OK', { focusColor: '#ff7e5f' });
    attachScene(button, true);
    button.focused = true;

    const r = recordingRenderer();
    button.render(r as never);

    expect(r.strokes.some((s) => s.color === 'Highlight')).toBe(true);
    expect(r.strokes.some((s) => s.color === '#ff7e5f')).toBe(false);
  });
});

describe('Slider focus ring', () => {
  it('defaults focusColor to cyan and starts unfocused', () => {
    const slider = new Slider();
    expect(slider.focusColor).toBe('#00f0ff');
    expect(slider.focused).toBe(false);
  });

  it('tracks focus and blur, marking the scene dirty each way', () => {
    const slider = new Slider();
    const markDirty = attachScene(slider);

    slider.emit('focus', {});
    expect(slider.focused).toBe(true);
    slider.emit('blur', {});
    expect(slider.focused).toBe(false);

    // Once per state change: an on-demand scene would otherwise not repaint the
    // ring, which is the whole point of drawing it.
    expect(markDirty).toHaveBeenCalledTimes(2);
  });

  it('strokes a ring around the handle only while focused', () => {
    const slider = new Slider({ focusColor: '#ff7e5f' });
    attachScene(slider);

    const before = recordingRenderer();
    slider.render(before as never);
    expect(before.strokes.some((s) => s.color === '#ff7e5f')).toBe(false);

    slider.emit('focus', {});
    const after = recordingRenderer();
    slider.render(after as never);
    expect(after.strokes.some((s) => s.color === '#ff7e5f' && s.lineWidth === 2)).toBe(true);
  });

  it('yields to the system Highlight color under forced colors', () => {
    const slider = new Slider({ focusColor: '#ff7e5f' });
    attachScene(slider, true);
    slider.emit('focus', {});

    const r = recordingRenderer();
    slider.render(r as never);

    expect(r.strokes.some((s) => s.color === 'Highlight')).toBe(true);
    expect(r.strokes.some((s) => s.color === '#ff7e5f')).toBe(false);
  });
});

describe('Checkbox focus ring (#683)', () => {
  it('defaults focusColor to cyan and starts unfocused', () => {
    const cb = new Checkbox({ label: 'Accept' });
    expect(cb.focusColor).toBe('#00f0ff');
    expect(cb.focused).toBe(false);
  });

  it('tracks focus and blur, marking the scene dirty each way', () => {
    const cb = new Checkbox({ label: 'Accept' });
    const markDirty = attachScene(cb);

    cb.emit('focus', {});
    expect(cb.focused).toBe(true);
    cb.emit('blur', {});
    expect(cb.focused).toBe(false);

    // Once per state change: an on-demand scene would otherwise not repaint the
    // ring, which is the whole point of drawing it.
    expect(markDirty).toHaveBeenCalledTimes(2);
  });

  it('strokes a ring around the box only while focused', () => {
    const cb = new Checkbox({ label: 'Accept', focusColor: '#ff7e5f' });
    attachScene(cb);

    const before = recordingRenderer();
    cb.render(before as never);
    expect(before.strokes.some((s) => s.color === '#ff7e5f')).toBe(false);

    cb.emit('focus', {});
    const after = recordingRenderer();
    cb.render(after as never);
    expect(after.strokes.some((s) => s.color === '#ff7e5f' && s.lineWidth === 2)).toBe(true);
  });

  it('yields to the system Highlight color under forced colors', () => {
    const cb = new Checkbox({ label: 'Accept', focusColor: '#ff7e5f' });
    attachScene(cb, true);
    cb.emit('focus', {});

    const r = recordingRenderer();
    cb.render(r as never);

    expect(r.strokes.some((s) => s.color === 'Highlight')).toBe(true);
    expect(r.strokes.some((s) => s.color === '#ff7e5f')).toBe(false);
  });
});

describe('Toggle focus ring (#683)', () => {
  it('defaults focusColor to cyan and starts unfocused', () => {
    const tg = new Toggle({ label: 'Dark mode' });
    expect(tg.focusColor).toBe('#00f0ff');
    expect(tg.focused).toBe(false);
  });

  it('tracks focus and blur, marking the scene dirty each way', () => {
    const tg = new Toggle({ label: 'Dark mode' });
    const markDirty = attachScene(tg);

    tg.emit('focus', {});
    expect(tg.focused).toBe(true);
    tg.emit('blur', {});
    expect(tg.focused).toBe(false);

    expect(markDirty).toHaveBeenCalledTimes(2);
  });

  it('strokes a ring around the track only while focused', () => {
    const tg = new Toggle({ label: 'Dark mode', focusColor: '#ff7e5f' });
    attachScene(tg);

    const before = recordingRenderer();
    tg.render(before as never);
    expect(before.strokes.some((s) => s.color === '#ff7e5f')).toBe(false);

    tg.emit('focus', {});
    const after = recordingRenderer();
    tg.render(after as never);
    expect(after.strokes.some((s) => s.color === '#ff7e5f' && s.lineWidth === 2)).toBe(true);
  });

  it('yields to the system Highlight color under forced colors', () => {
    const tg = new Toggle({ label: 'Dark mode', focusColor: '#ff7e5f' });
    attachScene(tg, true);
    tg.emit('focus', {});

    const r = recordingRenderer();
    tg.render(r as never);

    expect(r.strokes.some((s) => s.color === 'Highlight')).toBe(true);
    expect(r.strokes.some((s) => s.color === '#ff7e5f')).toBe(false);
  });
});

describe('Dropdown menu theming', () => {
  const OPTIONS = ['One', 'Two', 'Three'];

  it('defaults to the dark slate menu so existing themes are unchanged', () => {
    const dd = new Dropdown(OPTIONS);
    expect(dd.menuBg).toBe('rgba(15, 23, 42, 0.95)');
    expect(dd.menuColor).toBe('#fff');
    expect(dd.menuSelectedBg).toBe('rgba(0, 240, 255, 0.25)');
    expect(dd.menuHighlightBg).toBe('rgba(0, 240, 255, 0.4)');
    expect(dd.focusColor).toBe('#00f0ff');
  });

  it('paints option rows with the configured colors when opened', () => {
    const dd = new Dropdown(OPTIONS, {
      value: 'Two',
      menuBg: '#fffaf5',
      menuColor: '#453c38',
      menuSelectedBg: 'rgba(255, 126, 95, 0.25)',
      menuHighlightBg: 'rgba(255, 126, 95, 0.5)',
    });
    attachScene(dd);

    dd.openMenu();

    const items = collectOptionButtons(dd);
    expect(items).toHaveLength(3);

    const [one, two, three] = items;
    // openMenu highlights the selected row, so it lands on menuHighlightBg
    // rather than menuSelectedBg; the unselected rows take the plain menu bg.
    expect(two.bg).toBe('rgba(255, 126, 95, 0.5)');
    expect(one.bg).toBe('#fffaf5');
    expect(three.bg).toBe('#fffaf5');
    for (const item of items) expect(item.color).toBe('#453c38');

    // No cyan default survives anywhere in a fully themed menu.
    for (const item of items) expect(item.bg).not.toContain('240, 255');
  });

  it('falls back to menuSelectedBg for the selection once the highlight moves', () => {
    const dd = new Dropdown(OPTIONS, {
      value: 'Two',
      menuBg: '#fffaf5',
      menuSelectedBg: 'rgba(255, 126, 95, 0.25)',
      menuHighlightBg: 'rgba(255, 126, 95, 0.5)',
    });
    attachScene(dd);

    dd.openMenu();
    // Move the highlight off the selected row.
    (dd as unknown as { highlightedIndex: number }).highlightedIndex = 0;
    (dd as unknown as { updateMenuHighlight(): void }).updateMenuHighlight();

    const [one, two, three] = collectOptionButtons(dd);
    expect(one.bg).toBe('rgba(255, 126, 95, 0.5)');
    expect(two.bg).toBe('rgba(255, 126, 95, 0.25)');
    expect(three.bg).toBe('#fffaf5');
  });

  it('forwards focusColor to the trigger and to every option row', () => {
    const dd = new Dropdown(OPTIONS, { focusColor: '#ff7e5f' });
    attachScene(dd);

    expect((dd as unknown as { button: Button }).button.focusColor).toBe('#ff7e5f');

    dd.openMenu();
    for (const item of collectOptionButtons(dd)) {
      expect(item.focusColor).toBe('#ff7e5f');
    }
  });

  it('uses menuHighlightBg for the keyboard-highlighted row, over the selection', () => {
    const dd = new Dropdown(OPTIONS, {
      value: 'One',
      menuBg: '#fffaf5',
      menuSelectedBg: 'rgba(255, 126, 95, 0.25)',
      menuHighlightBg: 'rgba(255, 126, 95, 0.5)',
    });
    attachScene(dd);

    dd.openMenu();
    // Highlight the selected row: highlight must win, since both apply at once.
    (dd as unknown as { highlightedIndex: number }).highlightedIndex = 0;
    (dd as unknown as { updateMenuHighlight(): void }).updateMenuHighlight();

    const [one, two] = collectOptionButtons(dd);
    expect(one.bg).toBe('rgba(255, 126, 95, 0.5)');
    expect(two.bg).toBe('#fffaf5');
  });
});

/** Pulls the option `Button`s out of the open menu, in option order. */
function collectOptionButtons(dd: Dropdown): Button[] {
  const menu = (dd as unknown as { activeMenu?: { children: unknown[] } }).activeMenu;
  if (!menu) return [];
  return menu.children.filter((child): child is Button => child instanceof Button);
}
