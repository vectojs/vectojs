import { UIComponent } from './UIComponent';
import { type IRenderer, type A11yAttributes } from '@vectojs/core';

export class Slider extends UIComponent {
  public min: number;
  public max: number;
  public value: number;
  private isDragging: boolean = false;
  private trackColor: string;
  private progressColor: string;
  private handleColor: string;

  constructor(props: any = {}) {
    super(props);
    this.min = props.min ?? 0;
    this.max = props.max ?? 100;
    this.value = props.value ?? this.min;
    this.trackColor = props.trackColor ?? 'rgba(255, 255, 255, 0.15)';
    this.progressColor = props.progressColor ?? '#00f0ff';
    this.handleColor = props.handleColor ?? '#fff';

    this.width = props.width ?? 200;
    this.height = props.height ?? 24;
    this.interactive = true;

    this.on('pointerdown', (e: any) => {
      this.isDragging = true;
      this.updateValueFromPointer(e.clientX);
    });

    this.on('pointermove', (e: any) => {
      if (this.isDragging) {
        this.updateValueFromPointer(e.clientX);
      }
    });

    this.on('pointerup', () => {
      this.isDragging = false;
    });

    this.on('change', (e: { value: number }) => {
      props.onChange?.(e.value);
    });
  }

  private updateValueFromPointer(clientX: number) {
    const globalPos = this.getGlobalPosition();
    const relativeX = Math.max(0, Math.min(this.width, clientX - globalPos.x));
    const fraction = relativeX / this.width;
    const rawValue = this.min + fraction * (this.max - this.min);
    this.value = Math.round(rawValue);
    this.emit('change', { value: this.value });
  }

  public getA11yAttributes(): A11yAttributes {
    return {
      role: 'slider',
      value: String(this.value),
      valuemin: String(this.min),
      valuemax: String(this.max),
    };
  }

  public render(r: IRenderer): void {
    const thickness = 6;
    const progressFraction = (this.value - this.min) / (this.max - this.min);
    const progressWidth = this.width * progressFraction;
    const centerY = this.height / 2;

    // Track
    r.beginPath();
    r.roundRect(0, centerY - thickness / 2, this.width, thickness, thickness / 2);
    r.fill(this.trackColor);

    // Active Progress
    r.beginPath();
    r.roundRect(0, centerY - thickness / 2, progressWidth, thickness, thickness / 2);
    r.fill(this.progressColor);

    // Handle (Thumb)
    const handleRadius = 8;
    r.beginPath();
    r.arc(progressWidth, centerY, handleRadius, 0, Math.PI * 2);
    r.fill(this.handleColor);
  }
}
