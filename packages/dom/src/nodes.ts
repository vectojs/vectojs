import { Entity, type A11yAttributes, type Bounds } from '@vectojs/core';

/**
 * P1 prototype node set (RFC §3/§4.1, research P1): explicit per-node opt-in
 * only — each class sets `domPolicy = 'dom'` in its constructor. `'auto'`
 * switching heuristics are CTX-0601 and out of scope.
 *
 * All five render as no-ops on canvas: while resident, the live element owns
 * the visuals (the Scene walk skips canvas paint for resident leaves). If the
 * backend is absent (SSR) the walk falls through to canvas — where these paint
 * nothing — and `getA11yAttributes` keeps the transparent-mirror fallback
 * meaningful if the policy flips back to `'canvas'`.
 */
/** Selectable/copyable prose → `div` with `user-select: text`. */
export class DOMText extends Entity {
  public text: string;

  constructor(id?: string, text: string = '', width = 200, height = 24) {
    super(id);
    this.text = text;
    this.width = width;
    this.height = height;
    this.domPolicy = 'dom';
    this.domKind = 'text';
    this.interactive = true;
  }

  override getBounds(): Bounds | null {
    if (this.width <= 0 || this.height <= 0) return null;
    return { x: 0, y: 0, width: this.width, height: this.height };
  }

  override isPointInside(globalX: number, globalY: number): boolean {
    const local = this.worldToLocal(globalX, globalY);
    if (!local) return false;
    return local.x >= 0 && local.x <= this.width && local.y >= 0 && local.y <= this.height;
  }

  override render(): void {}

  public override getA11yAttributes(): A11yAttributes {
    return { tag: 'div', role: 'text', label: this.text };
  }
}

/** Native pressable control → `button`. Clicks arrive via the event bridge. */
export class DOMButton extends Entity {
  public label: string;

  constructor(id?: string, label: string = '', width = 120, height = 36) {
    super(id);
    this.label = label;
    this.width = width;
    this.height = height;
    this.domPolicy = 'dom';
    this.domKind = 'button';
    this.interactive = true;
  }

  override getBounds(): Bounds | null {
    if (this.width <= 0 || this.height <= 0) return null;
    return { x: 0, y: 0, width: this.width, height: this.height };
  }

  override isPointInside(globalX: number, globalY: number): boolean {
    const local = this.worldToLocal(globalX, globalY);
    if (!local) return false;
    return local.x >= 0 && local.x <= this.width && local.y >= 0 && local.y <= this.height;
  }

  override render(): void {}

  public override getA11yAttributes(): A11yAttributes {
    return { tag: 'button', role: 'button', label: this.label };
  }
}

/**
 * Native text entry → `input`. Typing and IME composition work with zero
 * framework key handling; the bridge syncs the element value back onto
 * {@link value} and forwards `VectoJSEvent('change')`.
 */
export class DOMInput extends Entity {
  public value: string;
  public placeholder?: string;

  constructor(id?: string, value: string = '', width = 200, height = 32) {
    super(id);
    this.value = value;
    this.width = width;
    this.height = height;
    this.domPolicy = 'dom';
    this.domKind = 'input';
    this.interactive = true;
  }

  override getBounds(): Bounds | null {
    if (this.width <= 0 || this.height <= 0) return null;
    return { x: 0, y: 0, width: this.width, height: this.height };
  }

  override isPointInside(globalX: number, globalY: number): boolean {
    const local = this.worldToLocal(globalX, globalY);
    if (!local) return false;
    return local.x >= 0 && local.x <= this.width && local.y >= 0 && local.y <= this.height;
  }

  override render(): void {}

  public override getA11yAttributes(): A11yAttributes {
    return { tag: 'input', role: 'textbox', label: this.placeholder ?? 'input', value: this.value };
  }
}

/**
 * Grouping node → plain `div`. Non-leaf residents keep the walk recursing so
 * opted-in descendants stay synced; canvas-policy children paint at the same
 * world coordinates, so mixed subtrees compose.
 */
export class DOMContainer extends Entity {
  constructor(id?: string, width = 0, height = 0) {
    super(id);
    this.width = width;
    this.height = height;
    this.domPolicy = 'dom';
    this.domKind = 'container';
    this.interactive = true;
  }

  override getBounds(): Bounds | null {
    if (this.width <= 0 || this.height <= 0) return null;
    return { x: 0, y: 0, width: this.width, height: this.height };
  }

  override isPointInside(globalX: number, globalY: number): boolean {
    const local = this.worldToLocal(globalX, globalY);
    if (!local) return false;
    return local.x >= 0 && local.x <= this.width && local.y >= 0 && local.y <= this.height;
  }

  override render(): void {}
}

/** Transform-only grouping node → pass-through `div` (position/rotation/scale). */
export class DOMTransform extends Entity {
  constructor(id?: string) {
    super(id);
    this.domPolicy = 'dom';
    this.domKind = 'transform';
    this.interactive = true;
  }

  override getBounds(): Bounds | null {
    return null;
  }

  override isPointInside(_globalX: number, _globalY: number): boolean {
    return false;
  }

  override render(): void {}
}
