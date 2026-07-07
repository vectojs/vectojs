import { UIComponent } from './UIComponent';
import { type IRenderer, type A11yAttributes } from '@vectojs/core';

export class Slider extends UIComponent {
  public min: number;
  public max: number;
  public value: number;
  /** Value granularity. Pointer and keyboard input snap to multiples of this. */
  public step: number;
  private isDragging: boolean = false;
  private trackColor: string;
  private progressColor: string;
  private handleColor: string;

  constructor(props: any = {}) {
    super();
    this.min = props.min ?? 0;
    this.max = props.max ?? 100;
    this.value = props.value ?? this.min;
    this.step = props.step ?? 1;
    this.trackColor = props.trackColor ?? 'rgba(255, 255, 255, 0.15)';
    this.progressColor = props.progressColor ?? '#00f0ff';
    this.handleColor = props.handleColor ?? '#fff';

    this.width = props.width ?? 200;
    this.height = props.height ?? 24;
    this.interactive = true;

    this.on('pointerdown', (e: any) => {
      this.isDragging = true;
      this.updateValueFromPointer(e.localX);
    });

    this.on('pointermove', (e: any) => {
      if (this.isDragging) {
        this.updateValueFromPointer(e.localX);
      }
    });

    this.on('pointerup', () => {
      this.isDragging = false;
    });

    this.on('keydown', (e: any) => {
      const key = e.nativeEvent?.key;
      if (!key) return;
      let next: number | null = null;
      switch (key) {
        case 'ArrowRight':
        case 'ArrowUp':
          next = this.value + this.step;
          break;
        case 'ArrowLeft':
        case 'ArrowDown':
          next = this.value - this.step;
          break;
        case 'Home':
          next = this.min;
          break;
        case 'End':
          next = this.max;
          break;
        default:
          return;
      }
      e.preventDefault?.();
      this.setValue(next);
    });

    this.on('change', (e: { value: number }) => {
      props.onChange?.(e.value);
    });
  }

  /** Snap to the step grid (anchored at `min`) and clamp into [min, max]. */
  private snapToStep(raw: number): number {
    const stepped = this.min + Math.round((raw - this.min) / this.step) * this.step;
    return Math.max(this.min, Math.min(this.max, stepped));
  }

  private setValue(raw: number): void {
    const nextValue = this.snapToStep(raw);
    if (nextValue === this.value) return;
    this.value = nextValue;
    this.emit('change', { value: this.value });
    this.scene?.markDirty();
  }

  private updateValueFromPointer(localX: number | undefined) {
    if (localX === undefined) return;
    const relativeX = Math.max(0, Math.min(this.width, localX));
    const fraction = relativeX / this.width;
    this.setValue(this.min + fraction * (this.max - this.min));
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
