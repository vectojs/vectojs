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
  /** Show a close affordance on each tab and route clicks to `onClose`. */
  closable?: boolean;
  /**
   * Preferred tab width in px. Tabs keep this width and the bar scrolls
   * horizontally when they overflow, instead of shrinking to slivers as the
   * count grows. Default `160`.
   */
  tabWidth?: number;
  /** Lower bound the preferred width collapses to before scrolling kicks in. Default `96`. */
  minTabWidth?: number;
  /**
   * Hide the tab bar while there are fewer than two tabs and let the content
   * occupy the full height — Vim's `showtabline=1` behavior. The bar (and its
   * hit region) reappears as soon as a second tab is added. Default `false`.
   */
  autoHideTabBar?: boolean;
  onChange?: (value: string) => void;
  onClose?: (value: string) => void;
}

/**
 * A tabbed panel container.
 * Auto-mounts the active tab content view and manages tab-bar rendering and events.
 *
 * Tabs keep a fixed preferred width and the bar scrolls horizontally once they
 * overflow (mouse wheel, or automatically to keep the active tab visible), so a
 * large number of open buffers stays legible instead of collapsing to slivers.
 *
 * @example
 * const tabs = new Tabs({
 *   width: 400,
 *   height: 300,
 *   closable: true,
 *   onClose: (id) => model.closeBuffer(id),
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
  public closable: boolean;
  public tabWidth: number;
  public minTabWidth: number;
  public autoHideTabBar: boolean;

  private _hoverIdx: number = -1;
  private _hoverClose: boolean = false;
  private _scrollX: number = 0;
  private readonly _closeBox = 14; // px hit region for the × glyph

  constructor(opts: TabsOptions) {
    super();
    this.tabs = opts.tabs;
    this.value = opts.value ?? (opts.tabs.length > 0 ? opts.tabs[0].id : '');
    this.width = opts.width;
    this.height = opts.height;
    this.tabHeight = opts.tabHeight ?? 40;
    this.font = opts.font ?? '14px sans-serif';
    this.color = opts.color ?? '#94a3b8';
    this.selectedColor = opts.selectedColor ?? '#00f0ff';
    this.borderColor = opts.borderColor ?? 'rgba(255,255,255,0.1)';
    this.closable = opts.closable ?? false;
    this.tabWidth = opts.tabWidth ?? 160;
    this.minTabWidth = opts.minTabWidth ?? 96;
    this.autoHideTabBar = opts.autoHideTabBar ?? false;
    this.interactive = true;

    this._updateContentVisibility();

    this.on('pointerdown', (e: { localX?: number; localY?: number }) => {
      const { localX: lx, localY: ly } = e;
      if (lx === undefined || ly === undefined) return;
      const barH = this._barHeight();
      if (barH === 0 || ly < 0 || ly > barH) return;
      const idx = this._tabIdxAt(lx);
      if (idx === -1) return;
      const tab = this.tabs[idx];
      if (this.closable && this._isOverClose(lx, idx)) {
        opts.onClose?.(tab.id);
        return;
      }
      if (tab.id !== this.value) {
        this.emit('change', { value: tab.id });
      }
    });

    this.on('pointermove', (e: { localX?: number; localY?: number }) => {
      const { localX: lx, localY: ly } = e;
      if (lx === undefined || ly === undefined) return;
      const barH = this._barHeight();
      if (barH > 0 && ly >= 0 && ly <= barH) {
        this._hoverIdx = this._tabIdxAt(lx);
        this._hoverClose =
          this.closable && this._hoverIdx !== -1 && this._isOverClose(lx, this._hoverIdx);
      } else {
        this._hoverIdx = -1;
        this._hoverClose = false;
      }
      this.scene?.markDirty();
    });

    this.on('wheel', (e: { deltaY?: number; deltaX?: number; nativeEvent?: Event }) => {
      const max = this._maxScroll();
      if (max <= 0) return;
      const d =
        Math.abs(e.deltaX ?? 0) > Math.abs(e.deltaY ?? 0) ? (e.deltaX ?? 0) : (e.deltaY ?? 0);
      const next = Math.max(0, Math.min(max, this._scrollX + d));
      if (next !== this._scrollX) {
        this._scrollX = next;
        (e.nativeEvent as Event | undefined)?.preventDefault?.();
        this.scene?.markDirty();
      }
    });

    this.on('pointerleave', () => {
      this._hoverIdx = -1;
      this._hoverClose = false;
      this.scene?.markDirty();
    });

    this.on('change', (e: { value: string }) => {
      if (this.value === e.value) return;
      this.value = e.value;
      this._ensureActiveVisible();
      this._updateContentVisibility();
      opts.onChange?.(this.value);
      this.scene?.markDirty();
    });
  }

  /**
   * The height the tab bar currently occupies — `0` when `autoHideTabBar`
   * has hidden it. Owners that lay out siblings around the bar (status
   * lines, gutters) should read this instead of assuming `tabHeight`.
   */
  public get effectiveTabBarHeight(): number {
    return this._barHeight();
  }

  private _barHeight(): number {
    return this.autoHideTabBar && this.tabs.length < 2 ? 0 : this.tabHeight;
  }

  private _tabW(): number {
    // Prefer the fixed width; only compress toward minTabWidth if that lets
    // every tab fit without scrolling. Below that, scroll instead of shrink.
    // Never stretch past tabWidth: on a wide bar the stretched tab's
    // right-edge × renders directly beside the NEXT tab's label, and users
    // close the wrong tab. Surplus bar width stays empty.
    if (this.tabs.length === 0) return this.tabWidth;
    const even = this.width / this.tabs.length;
    if (even >= this.tabWidth) return this.tabWidth;
    return Math.max(this.minTabWidth, Math.min(this.tabWidth, even));
  }

  private _contentWidth(): number {
    return this._tabW() * this.tabs.length;
  }

  private _maxScroll(): number {
    return Math.max(0, this._contentWidth() - this.width);
  }

  private _ensureActiveVisible(): void {
    const idx = this.tabs.findIndex((t) => t.id === this.value);
    if (idx === -1) return;
    const w = this._tabW();
    const left = idx * w;
    const right = left + w;
    if (left < this._scrollX) this._scrollX = left;
    else if (right > this._scrollX + this.width) this._scrollX = right - this.width;
    this._scrollX = Math.max(0, Math.min(this._maxScroll(), this._scrollX));
  }

  private _tabIdxAt(lx: number): number {
    const w = this._tabW();
    const idx = Math.floor((lx + this._scrollX) / w);
    if (idx >= 0 && idx < this.tabs.length) return idx;
    return -1;
  }

  private _closeCenterX(idx: number): number {
    const w = this._tabW();
    return idx * w + w - 12 - this._scrollX;
  }

  private _isOverClose(lx: number, idx: number): boolean {
    return Math.abs(lx - this._closeCenterX(idx)) <= this._closeBox / 2;
  }

  private _updateContentVisibility(): void {
    const contentY = this._barHeight();
    const contentH = this.height - contentY;

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

  /**
   * Re-derive content geometry every frame: `tabs` is a public field owners
   * reassign directly (no setter to intercept), and the bar height itself is
   * dynamic under `autoHideTabBar` — the active content must follow both
   * without requiring a `change` emit.
   */
  public update(dt: number, time: number): void {
    super.update(dt, time);
    this._updateContentVisibility();
  }

  public render(r: IRenderer): void {
    if (this._barHeight() === 0) return;
    const tabW = this._tabW();
    this._scrollX = Math.max(0, Math.min(this._maxScroll(), this._scrollX));

    // Tab bar border
    r.beginPath();
    r.moveTo(0, this.tabHeight);
    r.lineTo(this.width, this.tabHeight);
    r.stroke(this.borderColor, 1);

    // Clip the strip so scrolled-out tabs don't paint past the bar
    r.save();
    r.clip(0, 0, this.width, this.tabHeight);

    const closePad = this.closable ? this._closeBox + 6 : 8;
    for (let i = 0; i < this.tabs.length; i++) {
      const tab = this.tabs[i];
      const x = i * tabW - this._scrollX;
      if (x + tabW < 0 || x > this.width) continue; // virtualize off-screen tabs
      const active = tab.id === this.value;

      // Truncate the label to the available room (leave space for ×)
      const avail = tabW - 16 - closePad;
      const label = this._truncate(tab.label, avail);
      const textColor = active ? this.selectedColor : this.color;
      r.fillText(label, x + 12, this.tabHeight / 2 + 4, this.font, textColor);

      // Close affordance
      if (this.closable) {
        const cx = this._closeCenterX(i);
        const overThis = this._hoverIdx === i && this._hoverClose;
        if (overThis) {
          r.beginPath();
          r.roundRect(cx - 8, this.tabHeight / 2 - 8, 16, 16, 4);
          r.fill('rgba(255,255,255,0.12)');
        }
        r.fillText(
          '×',
          cx - 4,
          this.tabHeight / 2 + 4,
          this.font,
          overThis ? '#f87171' : this.color,
        );
      }

      // Active underline
      if (active) {
        r.beginPath();
        r.moveTo(x + 12, this.tabHeight - 2);
        r.lineTo(x + tabW - 12, this.tabHeight - 2);
        r.stroke(this.selectedColor, 3);
      } else if (i === this._hoverIdx && !this._hoverClose) {
        r.beginPath();
        r.moveTo(x + 20, this.tabHeight - 2);
        r.lineTo(x + tabW - 20, this.tabHeight - 2);
        r.stroke('rgba(255,255,255,0.2)', 2);
      }

      // Divider between tabs
      r.beginPath();
      r.moveTo(x + tabW, 6);
      r.lineTo(x + tabW, this.tabHeight - 6);
      r.stroke(this.borderColor, 1);
    }
    r.restore();

    // Scroll hint: fade markers when there is more strip either side
    if (this._scrollX > 0) this._edgeFade(r, true);
    if (this._scrollX < this._maxScroll()) this._edgeFade(r, false);
  }

  private _truncate(label: string, avail: number): string {
    if (avail <= 0) return '';
    if (measureText(label, this.font) <= avail) return label;
    let lo = 0;
    let hi = label.length;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (measureText(label.slice(0, mid) + '…', this.font) <= avail) lo = mid;
      else hi = mid - 1;
    }
    return lo > 0 ? label.slice(0, lo) + '…' : '…';
  }

  private _edgeFade(r: IRenderer, left: boolean): void {
    const w = 18;
    const x = left ? 0 : this.width - w;
    r.beginPath();
    r.roundRect(x, 0, w, this.tabHeight - 2, 0);
    r.fill(left ? 'rgba(0,0,0,0.28)' : 'rgba(0,0,0,0.28)');
  }

  public getA11yAttributes(): A11yAttributes {
    return {
      role: 'tablist',
      label: 'Tab switching panel',
    };
  }
}
