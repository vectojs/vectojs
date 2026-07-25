import { UIComponent } from './UIComponent';
import { Card } from './Card';
import { Text } from './Text';
import { Button } from './Button';
import { type A11yAttributes, type IRenderer, VectoJSEvent } from '@vectojs/core';

export class Modal extends UIComponent {
  private card: Card;
  private backdropColor: string;
  /** Element focused before the modal opened, restored on close. */
  private _restoreFocusEl: HTMLElement | null = null;

  constructor(title: string, props: any = {}) {
    super();
    // The backdrop is the full-viewport focus-catching dialog surface.
    this.a11yFullViewport = true;
    this.width = props.width ?? (typeof window !== 'undefined' ? window.innerWidth : 800);
    this.height = props.height ?? (typeof window !== 'undefined' ? window.innerHeight : 600);
    this.interactive = true;
    this.backdropColor = props.backdropColor ?? 'rgba(0, 0, 0, 0.5)';

    // Central Card modal
    const modalW = props.modalWidth ?? 400;
    const modalH = props.modalHeight ?? 250;
    this.card = new Card({
      width: modalW,
      height: modalH,
      bg: props.cardBg ?? 'rgba(15, 23, 42, 0.95)',
      border: props.cardBorder ?? 'rgba(255, 255, 255, 0.15)',
      radius: 16,
    });

    this.card.x = (this.width - modalW) / 2;
    this.card.y = (this.height - modalH) / 2;

    const titleText = new Text(title, {
      font: '600 20px sans-serif',
      color: '#fff',
    });
    this.card.add(titleText.setPosition(24, 24));

    const closeBtn = new Button('Close', {
      bg: 'rgba(255, 255, 255, 0.1)',
      color: '#fff',
      radius: 8,
    });
    closeBtn.width = 80;
    closeBtn.height = 36;
    closeBtn.on('click', (e: VectoJSEvent) => {
      e.stopPropagation();
      void this.close();
    });
    this.card.add(closeBtn.setPosition(modalW - 104, modalH - 60));

    this.add(this.card);

    // The card scales in on mount (onMounted) and out on close() through the
    // shared animation system's imperative springTo. Seed it collapsed so the
    // mount animation grows it from nothing. The Scene ticks the card each frame
    // (it recurses into descendants), so no per-frame update() override is needed.
    this.card.scaleX = 0;
    this.card.scaleY = 0;

    // Block underlying events
    this.on('click', (e: VectoJSEvent) => e.stopPropagation());
    this.on('pointerdown', (e: VectoJSEvent) => e.stopPropagation());
    // Esc closes the dialog (WAI-ARIA dialog pattern). The keydown reaches the
    // modal's shadow element once it holds focus (set in onMounted).
    this.on('keydown', (e: VectoJSEvent<KeyboardEvent>) => {
      if (e.nativeEvent?.key === 'Escape') {
        e.stopPropagation();
        void this.close();
      }
    });
  }

  /** Expose the modal shell as a real dialog so screen readers announce it and
   *  trap their reading context. `a11yFullViewport` makes the backdrop the
   *  focus-catching surface. */
  public override getA11yAttributes(): A11yAttributes {
    return { role: 'dialog', ariaModal: 'true', tabIndex: -1 };
  }

  protected override onMounted(): void {
    // Remember what had focus so we can restore it on close (WAI-ARIA dialog).
    this._restoreFocusEl =
      typeof document !== 'undefined' ? (document.activeElement as HTMLElement | null) : null;
    void this.card.springTo({ scaleX: 1, scaleY: 1 }, { stiffness: 180, damping: 14 });
    // Move focus into the dialog so Esc/keyboard work and SR context enters it.
    this.focus();
  }

  /** Animate the card out, then remove the modal from its overlay layer and
   *  restore focus to whatever held it before the modal opened. */
  public async close(): Promise<void> {
    await this.card.springTo({ scaleX: 0, scaleY: 0 }, { stiffness: 220, damping: 20 });
    this.scene?.hideOverlay(this);
    this._restoreFocusEl?.focus?.();
    this._restoreFocusEl = null;
  }

  public render(r: IRenderer): void {
    // Draw blocking dark backdrop overlay
    r.beginPath();
    r.roundRect(0, 0, this.width, this.height, 0);
    r.fill(this.backdropColor);
  }
}
