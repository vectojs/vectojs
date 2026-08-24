// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { ProgressBar } from '../src/ProgressBar';
import { Input } from '../src/Input';
import { TextArea } from '../src/TextArea';
import { Checkbox } from '../src/Checkbox';
import { Toggle } from '../src/Toggle';
import { Link } from '../src/Link';

describe('backlog #654 primitives', () => {
  describe('ProgressBar initial value routing', () => {
    it('clamps an out-of-range initial value instead of painting a 150% fill', () => {
      const bar = new ProgressBar({ value: 1.5 });
      expect(bar.value).toBe(1);
      expect(bar.getA11yAttributes().value).toBe('100');
    });

    it('treats a NaN value as 0 instead of projecting String(NaN)', () => {
      const bar = new ProgressBar({ value: Number.NaN });
      expect(bar.value).toBe(0);
      expect(bar.getA11yAttributes().value).toBe('0');
      expect(new ProgressBar({ value: -2 }).value).toBe(0);
    });

    it('keeps setValue clamping non-finite input too', () => {
      const bar = new ProgressBar({ value: 0.5 });
      bar.setValue(Number.NaN);
      expect(bar.value).toBe(0);
    });
  });

  describe('Input/TextArea accessible label', () => {
    it('prefers label over placeholder for the accessible name', () => {
      const input = new Input({ width: 200, placeholder: 'Search…', label: 'Site search' });
      expect(input.getA11yAttributes().label).toBe('Site search');

      const area = new TextArea({ width: 200, placeholder: 'Notes…', label: 'Meeting notes' });
      expect(area.getA11yAttributes().label).toBe('Meeting notes');
    });

    it('falls back to the placeholder when no label was given', () => {
      const input = new Input({ width: 200, placeholder: 'Search…' });
      expect(input.getA11yAttributes().label).toBe('Search…');
    });
  });

  describe('disabled across the control family', () => {
    it('Input projects disabled and drops change events while disabled', () => {
      const onChange = vi.fn();
      const input = new Input({ width: 200, onChange, disabled: true });
      expect(input.disabled).toBe(true);
      expect(input.getA11yAttributes().disabled).toBe(true);

      input.emit('change', { value: 'nope' });
      expect(input.value).toBe('');
      expect(onChange).not.toHaveBeenCalled();

      input.disabled = false;
      input.emit('change', { value: 'typed' });
      expect(input.value).toBe('typed');
    });

    it('TextArea projects disabled and drops change events while disabled', () => {
      const onChange = vi.fn();
      const area = new TextArea({ width: 200, onChange, disabled: true });
      expect(area.getA11yAttributes().disabled).toBe(true);

      area.emit('change', { value: 'nope' });
      expect(area.value).toBe('');
      expect(onChange).not.toHaveBeenCalled();
    });

    it('Checkbox projects disabled and refuses clicks + native change while disabled', () => {
      const onChange = vi.fn();
      const box = new Checkbox({ label: 'Accept', onChange, disabled: true });
      expect(box.getA11yAttributes().disabled).toBe(true);
      expect(box.getA11yAttributes()).toMatchObject({ tag: 'input', inputType: 'checkbox' });

      box.emit('click', {});
      box.emit('change', { checked: true }); // forged native event
      expect(box.checked).toBe(false);
      expect(onChange).not.toHaveBeenCalled();

      box.disabled = false;
      box.emit('click', {});
      expect(box.checked).toBe(true);
    });

    it('Toggle projects disabled and refuses state changes while disabled', () => {
      const onChange = vi.fn();
      const toggle = new Toggle({ label: 'Wifi', onChange, disabled: true });
      expect(toggle.getA11yAttributes().disabled).toBe(true);

      toggle.emit('click', {});
      toggle.emit('change', { checked: true });
      expect(toggle.checked).toBe(false);
      expect(onChange).not.toHaveBeenCalled();

      toggle.disabled = false;
      toggle.emit('click', {});
      expect(toggle.checked).toBe(true);
      expect(onChange).toHaveBeenCalledWith(true);
    });

    it('Link projects disabled, drops href, and never opens the URL while disabled', () => {
      const open = vi.fn();
      const originalOpen = globalThis.window?.open;
      if (typeof window !== 'undefined') window.open = open as never;

      try {
        const link = new Link('Docs', { href: 'https://example.com', disabled: true });
        expect(link.getA11yAttributes().disabled).toBe(true);
        expect(link.getA11yAttributes().href).toBeUndefined(); // nothing to middle-click

        link.emit('click', {});
        expect(open).not.toHaveBeenCalled();

        link.disabled = false;
        link.emit('click', {}); // canvas-path click (no native anchor target)
        expect(open).toHaveBeenCalledWith('https://example.com', '_blank', 'noopener');
      } finally {
        if (typeof window !== 'undefined' && originalOpen) window.open = originalOpen;
      }
    });
  });
});
