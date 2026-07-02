import { Entity, IRenderer } from '@vectojs/core';
import { Overlay, OverlayPlacement } from './Overlay';

export interface PopoverOptions {
  /** The entity that toggles this popover on click. */
  target: Entity;
  width: number;
  height: number;
  placement?: OverlayPlacement;
  bg?: string;
  borderColor?: string;
}

/**
 * A click-triggered popover panel that can contain arbitrary Entity children.
 * Clicking the target toggles visibility; clicking the target again closes it.
 *
 * @example
 * const pop = new Popover({ target: myButton, width: 200, height: 120 });
 * pop.add(new Button({ label: 'Option A', onClick: () => {} }));
 * scene.add(pop);
 */
export class Popover extends Overlay {
  private _bg: string;
  private _border: string;

  constructor(opts: PopoverOptions) {
    super({
      width: opts.width,
      height: opts.height,
      placement: opts.placement ?? 'bottom-start',
      offset: 6,
    });
    this._bg = opts.bg ?? 'rgba(15,15,30,0.96)';
    this._border = opts.borderColor ?? 'rgba(255,255,255,0.14)';
    this.interactive = true;

    opts.target.on('click', () => {
      if (this.visible) this.hide();
      else this.showAt(opts.target);
    });
  }

  public render(r: IRenderer): void {
    r.beginPath();
    r.roundRect(0, 0, this.width, this.height, 8);
    r.fill(this._bg);
    r.beginPath();
    r.roundRect(0, 0, this.width, this.height, 8);
    r.stroke(this._border, 1);
  }
}
