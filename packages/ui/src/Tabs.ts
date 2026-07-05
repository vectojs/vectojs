import { Entity, A11yAttributes, IRenderer } from '@vectojs/core';
import { UIComponent } from './UIComponent';
import { measureText } from './measure';

export interface TabItem {
  id: string;
  label: string;
  content: Entity;
}

export interface TabsOptions {
  tabs: TabItem[];
  value?: string;
  width: number;
  height: number;
  tabHeight?: number;
  font?: string;
  color?: string;
  selectedColor?: string;
  borderColor?: string;
  onChange?: (value: string) => void;
}

/**
 * A tabbed panel container.
 * Auto-mounts the active tab content view and manages tab-bar rendering and events.
 *
 * @example
 * const tabs = new Tabs({
 *   width: 400,
 *   height: 300,
 *   tabs: [
 *     { id: 'code', label: 'Code', content: codeEditorPanel },
 *     { id: 'preview', label: 'Preview', content: previewPanel },
 *   ],
 * });
 */
export class Tabs extends UIComponent {
  public tabs: TabItem[];
  public value: string;
  public tabHeight: number;
  public font: string;
  public color: string;
  public selectedColor: string;
  public borderColor: string;

  private _hoverIdx: number = -1;

  constructor(opts: TabsOptions) {
    super('Tabs');
    this.tabs = opts.tabs;
    this.value = opts.value ?? (opts.tabs.length > 0 ? opts.tabs[0].id : '');
    this.width = opts.width;
    this.height = opts.height;
    this.tabHeight = opts.tabHeight ?? 40;
    this.font = opts.font ?? '14px sans-serif';
    this.color = opts.color ?? '#94a3b8';
    this.selectedColor = opts.selectedColor ?? '#00f0ff';
    this.borderColor = opts.borderColor ?? 'rgba(255,255,255,0.1)';
    this.interactive = true;

    this._updateContentVisibility();

    this.on('pointerdown', (e: { localX?: number; localY?: number }) => {
      const { localX: lx, localY: ly } = e;
      if (lx === undefined || ly === undefined) return;
      if (ly >= 0 && ly <= this.tabHeight) {
        const idx = this._tabIdxAt(lx);
        if (idx !== -1) {
          const tab = this.tabs[idx];
          if (tab.id !== this.value) {
            this.emit('change', { value: tab.id });
          }
        }
      }
    });

    this.on('pointermove', (e: { localX?: number; localY?: number }) => {
      const { localX: lx, localY: ly } = e;
      if (lx === undefined || ly === undefined) return;
      if (ly >= 0 && ly <= this.tabHeight) {
        this._hoverIdx = this._tabIdxAt(lx);
      } else {
        this._hoverIdx = -1;
      }
      this.scene?.markDirty();
    });

    this.on('pointerleave', () => {
      this._hoverIdx = -1;
      this.scene?.markDirty();
    });

    this.on('change', (e: { value: string }) => {
      if (this.value === e.value) return;
      this.value = e.value;
      this._updateContentVisibility();
      opts.onChange?.(this.value);
      this.scene?.markDirty();
    });
  }

  private _tabWidth(): number {
    return this.width / this.tabs.length;
  }

  private _tabIdxAt(lx: number): number {
    const w = this._tabWidth();
    const idx = Math.floor(lx / w);
    if (idx >= 0 && idx < this.tabs.length) return idx;
    return -1;
  }

  private _updateContentVisibility(): void {
    const contentY = this.tabHeight;
    const contentH = this.height - this.tabHeight;

    for (const tab of this.tabs) {
      if (tab.id === this.value) {
        tab.content.x = 0;
        tab.content.y = contentY;
        tab.content.width = this.width;
        tab.content.height = contentH;
        if (!this.children.includes(tab.content)) {
          this.add(tab.content);
        }
      } else {
        if (this.children.includes(tab.content)) {
          this.remove(tab.content);
        }
      }
    }
  }

  public render(r: IRenderer): void {
    const tabW = this._tabWidth();

    // Render Tab bar border
    r.beginPath();
    r.moveTo(0, this.tabHeight);
    r.lineTo(this.width, this.tabHeight);
    r.stroke(this.borderColor, 1);

    for (let i = 0; i < this.tabs.length; i++) {
      const tab = this.tabs[i];
      const x = i * tabW;
      const active = tab.id === this.value;

      // Tab text (centered manually)
      const labelW = measureText(tab.label, this.font);
      const textX = x + tabW / 2 - labelW / 2;
      const textColor = active ? this.selectedColor : this.color;
      r.fillText(tab.label, textX, this.tabHeight / 2 + 4, this.font, textColor);

      // Active tab line indicator
      if (active) {
        r.beginPath();
        r.moveTo(x + 12, this.tabHeight - 2);
        r.lineTo(x + tabW - 12, this.tabHeight - 2);
        r.stroke(this.selectedColor, 3);
      }

      // Hover tab underline
      if (i === this._hoverIdx && !active) {
        r.beginPath();
        r.moveTo(x + 20, this.tabHeight - 2);
        r.lineTo(x + tabW - 20, this.tabHeight - 2);
        r.stroke('rgba(255,255,255,0.2)', 2);
      }
    }
  }

  public getA11yAttributes(): A11yAttributes {
    return {
      role: 'tablist',
      label: 'Tab switching panel',
    };
  }
}
