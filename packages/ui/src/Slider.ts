import { UIComponent } from './UIComponent';
import { type IRenderer, type A11yAttributes, type DevtoolsDescriptor } from '@vectojs/core';

/** Construction options for {@link Slider}. */
export interface SliderOptions {
  /** Minimum selectable value. Default `0`. */
  min?: number;
  /** Maximum selectable value. Must be >= `min`. Default `100`. */
  max?: number;
  /** Initial value; clamped into `[min, max]` and snapped to the step grid. Default `min`. */
  value?: number;
  /** Value granularity. Pointer and keyboard input snap to multiples of this. Must be > 0. Default `1`. */
  step?: number;
  /**
   * Accessible name. A `role="slider"` with no name is announced as just
   * "slider", giving no indication of what it controls (WCAG 4.1.2), so set this
   * whenever the surrounding visual label is drawn on canvas rather than
   * projected.
   */
  label?: string;
  /** Track color. Default `'rgba(255, 255, 255, 0.15)'`. */
  trackColor?: string;
  /** Filled-portion color. Default `'#00f0ff'`. */
  progressColor?: string;
  /** Thumb color. Default `'#fff'`. */
  handleColor?: string;
  /** Focus-ring color. Default `'#00f0ff'`. */
  focusColor?: string;
  /** Width in pixels. Default `200`. */
  width?: number;
  /** Height in pixels. Default `24`. */
  height?: number;
  /** Invoked with the snapped value whenever it changes. */
  onChange?: (value: number) => void;
  /** Whether the slider is disabled (no pointer/keyboard input, projected `disabled`). Default `false`. */
  disabled?: boolean;
}

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

  /**
   * Accessible name. A `role="slider"` with no name is announced as just
   * "slider", giving no indication of what it controls (WCAG 4.1.2), so set this
   * whenever the surrounding visual label is drawn on canvas rather than
   * projected.
   */
  public label?: string;

  /**
   * Focus-ring color, stroked 2px around the handle while focused. Default
   * `'#00f0ff'`. Ignored under forced-colors mode, which uses the system
   * `Highlight` color.
   */
  public focusColor: string;

  /** True while this slider holds keyboard focus. */
  public focused = false;

  private _disabled = false;

  constructor(props: SliderOptions = {}) {
    super();
    // Validate range/granularity before anything derives from them: an
    // inverted range renders nonsense on every frame, and a zero/negative or
    // non-finite step turns `snapToStep` into NaN poisoning of `value`, the
    // change stream and the devtools descriptor.
    const min = props.min ?? 0;
    const max = props.max ?? 100;
    if (!Number.isFinite(min) || !Number.isFinite(max) || max < min) {
      throw new Error(
        `Slider: max must be a finite number >= min (got min ${String(props.min)}, max ${String(props.max)})`,
      );
    }
    this.min = min;
    this.max = max;
    this.step = positiveStep(props.step ?? 1);
    this.label = props.label;
    this.trackColor = props.trackColor ?? 'rgba(255, 255, 255, 0.15)';
    this.progressColor = props.progressColor ?? '#00f0ff';
    this.handleColor = props.handleColor ?? '#fff';
    this.focusColor = props.focusColor ?? '#00f0ff';
    this._disabled = props.disabled ?? false;

    this.width = props.width ?? 200;
    this.height = props.height ?? 24;
    this.interactive = true;

    // Route the initial value through the same clamp/snap path as every later
    // mutation: a raw store let `value: 250` render the thumb past the track
    // with an off-range aria valuenow until the first interaction.
    this.value = this.snapToStep(props.value ?? this.min);

    this.on('focus', () => {
      this.focused = true;
      this.scene?.markDirty();
    });
    this.on('blur', () => {
      this.focused = false;
      this.scene?.markDirty();
    });

    this.on('pointerdown', (e: any) => {
      if (this._disabled) return;
      this.isDragging = true;
      this.updateValueFromPointer(e.localX);
    });

    this.on('pointermove', (e: any) => {
      if (this.isDragging && !this._disabled) {
        this.updateValueFromPointer(e.localX);
      }
    });

    this.on('pointerup', () => {
      this.isDragging = false;
    });

    this.on('pointercancel', () => {
      this.isDragging = false;
    });

    this.on('keydown', (e: any) => {
      if (this._disabled) return;
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

  /** Whether the slider is disabled. Projected so AT reports what the canvas draws. */
  public get disabled(): boolean {
    return this._disabled;
  }

  public set disabled(value: boolean) {
    if (this._disabled === value) return;
    this._disabled = value;
    if (value) this.isDragging = false;
    this.scene?.markDirty();
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
      label: this.label,
      value: String(this.value),
      valuemin: String(this.min),
      valuemax: String(this.max),
      // `undefined` when enabled: the projection removes an attribute set to
      // undefined, and HitTester already treats `disabled === true` as
      // pointer-transparent, so the canvas path and the shadow node agree.
      disabled: this._disabled ? true : undefined,
    };
  }

  /**
   * Range, step and the normalised position, plus whether `value` actually lands
   * on a step boundary — an off-step value is a real defect that renders fine.
   */
  public override getDevtoolsDescriptor(): DevtoolsDescriptor {
    const span = this.max - this.min;
    const normalized = span > 0 ? (this.value - this.min) / span : 0;
    const offStep = this.step > 0 && Math.abs((this.value - this.min) % this.step) > 1e-9;
    return {
      kind: 'Slider',
      groups: [
        {
          label: 'Value',
          fields: [
            { label: 'value', value: this.value },
            { label: 'min', value: this.min },
            { label: 'max', value: this.max },
            { label: 'step', value: this.step },
            {
              label: 'normalized',
              value: Math.round(normalized * 1000) / 1000,
              hint: '0..1 position of the thumb, what the renderer actually uses',
              readOnly: true,
            },
          ],
        },
      ],
      notes: offStep
        ? [
            `value ${this.value} is not on a step boundary (min ${this.min}, step ${this.step}); keyboard and drag will snap it on next interaction.`,
          ]
        : undefined,
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

    // Focus ring. A role="slider" is keyboard-operable (arrows/Home/End), so it
    // needs a visible focus indicator (WCAG 2.4.7); it previously drew none.
    if (this.focused) {
      const forced = this.scene?.forcedColors ?? false;
      r.beginPath();
      r.arc(progressWidth, centerY, handleRadius + 3, 0, Math.PI * 2);
      r.stroke(forced ? 'Highlight' : this.focusColor, 2);
    }
  }
}

function positiveStep(step: number): number {
  if (!Number.isFinite(step) || step <= 0) {
    throw new Error(`Slider: step must be a finite number > 0 (received ${String(step)})`);
  }
  return step;
}
