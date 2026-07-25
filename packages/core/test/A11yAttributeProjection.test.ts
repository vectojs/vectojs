// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { Scene, Entity, type A11yAttributes } from '../src';

/**
 * Coverage for the full `A11yAttributes` → `aria-*` projection. These fields are
 * what makes a canvas-drawn form announceable: without `aria-required` /
 * `aria-invalid` a zero-DOM validation state is invisible to a screen reader,
 * and `aria-labelledby` / `describedby` are the only way to associate a drawn
 * label or error text with its control.
 *
 * Also pins the clearing semantics: an attribute set to `undefined` must be
 * REMOVED from the element, not left stale from a previous frame.
 */
class AttrEntity extends Entity {
  public attrs: A11yAttributes = {};
  constructor(id: string) {
    super(id);
    this.interactive = true;
    this.width = 60;
    this.height = 20;
  }
  override getA11yAttributes(): A11yAttributes {
    return this.attrs;
  }
  isPointInside(): boolean {
    return false;
  }
  render(): void {}
}

function fakeCtx(): CanvasRenderingContext2D {
  return new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === 'measureText') return (t: string) => ({ width: t.length * 8 });
        if (prop === 'canvas') return { width: 0, height: 0, style: {} };
        return () => {};
      },
      set: () => true,
    },
  ) as unknown as CanvasRenderingContext2D;
}

describe('A11yAttributes → aria-* projection', () => {
  let scene: Scene;
  let entity: AttrEntity;

  /** Re-run the projection and return the entity's shadow element. */
  const sync = (): HTMLElement => {
    scene.render((scene as any).renderer, 16, 16);
    (scene as any).syncA11y((scene as any).root);
    return (scene as any).a11yElements.get('e') as HTMLElement;
  };

  beforeEach(() => {
    HTMLCanvasElement.prototype.getContext = (() => fakeCtx()) as never;
    const canvas = document.createElement('canvas');
    document.body.appendChild(canvas);
    scene = new Scene(canvas);
    entity = new AttrEntity('e');
    scene.add(entity);
  });

  it('projects the form-semantics fields', () => {
    entity.attrs = {
      role: 'textbox',
      required: true,
      invalid: true,
      labelledby: 'label-1',
      describedby: 'hint-1 error-1',
    };
    const el = sync();

    expect(el.getAttribute('aria-required')).toBe('true');
    expect(el.getAttribute('aria-invalid')).toBe('true');
    expect(el.getAttribute('aria-labelledby')).toBe('label-1');
    expect(el.getAttribute('aria-describedby')).toBe('hint-1 error-1');
  });

  it('projects live-region and hierarchy fields', () => {
    entity.attrs = {
      role: 'status',
      live: 'polite',
      atomic: true,
      relevant: 'additions text',
      level: 3,
    };
    const el = sync();

    expect(el.getAttribute('aria-live')).toBe('polite');
    expect(el.getAttribute('aria-atomic')).toBe('true');
    expect(el.getAttribute('aria-relevant')).toBe('additions text');
    expect(el.getAttribute('aria-level')).toBe('3');
  });

  it('projects false as "false", not as a removed attribute', () => {
    // aria-invalid="false" is meaningful (explicitly valid) and must survive.
    entity.attrs = { role: 'textbox', required: false, invalid: false };
    const el = sync();
    expect(el.getAttribute('aria-required')).toBe('false');
    expect(el.getAttribute('aria-invalid')).toBe('false');
  });

  it('removes an attribute when the field becomes undefined', () => {
    entity.attrs = {
      role: 'textbox',
      invalid: true,
      level: 2,
      labelledby: 'l',
    };
    let el = sync();
    expect(el.getAttribute('aria-invalid')).toBe('true');

    // The field goes away (validation passed, level no longer applies).
    entity.attrs = { role: 'textbox' };
    el = sync();
    expect(el.hasAttribute('aria-invalid')).toBe(false);
    expect(el.hasAttribute('aria-level')).toBe(false);
    expect(el.hasAttribute('aria-labelledby')).toBe(false);
  });

  it('updates a field in place across frames', () => {
    entity.attrs = { role: 'textbox', invalid: false };
    expect(sync().getAttribute('aria-invalid')).toBe('false');

    entity.attrs = { role: 'textbox', invalid: true };
    expect(sync().getAttribute('aria-invalid')).toBe('true');
  });
});
