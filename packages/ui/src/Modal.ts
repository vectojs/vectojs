import { UIComponent } from './UIComponent';
import { Card } from './Card';
import { Text } from './Text';
import { Button } from './Button';
import { SpringPhysics, type IRenderer, VectoUIEvent } from '@vecto-ui/core';

export class Modal extends UIComponent {
  private card: Card;
  private backdropColor: string;
  private spring: SpringPhysics;
  private closing: boolean = false;

  constructor(title: string, props: any = {}) {
    super(props);
    this.width = props.width ?? (typeof window !== 'undefined' ? window.innerWidth : 800);
    this.height = props.height ?? (typeof window !== 'undefined' ? window.innerHeight : 600);
    this.interactive = true;
    this.backdropColor = props.backdropColor ?? 'rgba(0, 0, 0, 0.5)';

    this.spring = new SpringPhysics(0); // Starts collapsed (scale=0)
    this.spring.target = 1; // Animation target (scale=1)

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
      width: 80,
      height: 36,
      bg: 'rgba(255, 255, 255, 0.1)',
      color: '#fff',
      radius: 8,
    });
    closeBtn.on('click', (e: VectoUIEvent) => {
      e.stopPropagation();
      this.close();
    });
    this.card.add(closeBtn.setPosition(modalW - 104, modalH - 60));

    this.add(this.card);

    // Block underlying events
    this.on('click', (e: VectoUIEvent) => e.stopPropagation());
    this.on('pointerdown', (e: VectoUIEvent) => e.stopPropagation());
  }

  public close() {
    this.closing = true;
    this.spring.target = 0; // Collapses scale to 0
  }

  public update(dt: number, time: number): void {
    super.update(dt, time);
    this.spring.update(dt / 1000); // Ticks Spring

    this.card.scaleX = this.spring.value;
    this.card.scaleY = this.spring.value;

    if (!this.spring.isAtRest()) {
      this.scene?.markDirty();
    } else if (this.closing && this.spring.value === 0) {
      // Safe deferred unmounting
      this.scene?.hideOverlay(this);
    }
  }

  public render(r: IRenderer): void {
    // Draw blocking dark backdrop overlay
    r.beginPath();
    r.roundRect(0, 0, this.width, this.height, 0);
    r.fill(this.backdropColor);
  }
}
