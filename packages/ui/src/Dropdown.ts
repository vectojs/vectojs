import { Entity, VectoJSEvent } from '@vectojs/core';
import { UIComponent } from './UIComponent';
import { Button } from './Button';
import { Stack } from './Stack';

export class Dropdown extends UIComponent {
  private options: string[];
  private selectedValue: string;
  private button: Button;
  private activeMenu: Stack | null = null;
  private activeBackdrop: Entity | null = null;
  private highlightedIndex: number = -1;

  /**
   * Accessible name. A `role="combobox"` with no name is announced as just
   * "combobox" (WCAG 4.1.2) — the selected value alone does not say what the
   * control is for.
   */
  public label?: string;

  /**
   * Background of an unselected option row in the open menu.
   *
   * Defaults to the dark slate the closed trigger also defaults to. Set it on a
   * light theme: the trigger's own `bg`/`color` were always overridable while
   * the menu's were not, so a themed dropdown opened a dark panel and read as a
   * rendering bug rather than a style. Default `'rgba(15, 23, 42, 0.95)'`.
   */
  public menuBg: string;

  /** Text color of option rows in the open menu. Default `'#fff'`. */
  public menuColor: string;

  /**
   * Background of the currently selected option row. Default
   * `'rgba(0, 240, 255, 0.25)'`.
   */
  public menuSelectedBg: string;

  /**
   * Background of the keyboard-highlighted option row. Should read as stronger
   * than {@link menuSelectedBg}, since both can apply at once. Default
   * `'rgba(0, 240, 255, 0.4)'`.
   */
  public menuHighlightBg: string;

  /**
   * Focus-ring color for the trigger and for option rows. Default `'#00f0ff'`.
   * Forwarded to the underlying `Button`s, so it follows the same forced-colors
   * behavior.
   */
  public focusColor: string;

  constructor(options: string[], props: any = {}) {
    super();
    this.label = props.label;
    this.options = options;
    this.selectedValue = props.value ?? (options.length > 0 ? options[0] : '');
    this.interactive = true;

    this.menuBg = props.menuBg ?? 'rgba(15, 23, 42, 0.95)';
    this.menuColor = props.menuColor ?? '#fff';
    this.menuSelectedBg = props.menuSelectedBg ?? 'rgba(0, 240, 255, 0.25)';
    this.menuHighlightBg = props.menuHighlightBg ?? 'rgba(0, 240, 255, 0.4)';
    this.focusColor = props.focusColor ?? '#00f0ff';

    this.width = props.width ?? 120;
    this.height = props.height ?? 36;

    this.button = new Button(this.selectedValue, {
      bg: props.bg ?? 'rgba(30, 41, 59, 0.85)',
      color: props.color ?? '#fff',
      radius: props.radius ?? 8,
      font: props.font ?? '14px sans-serif',
      focusColor: this.focusColor,
    });
    this.button.width = this.width;
    this.button.height = this.height;
    // Disable inner button interactivity to delegate all pointer events and keyboard focus handling to parent Dropdown
    this.button.interactive = false;
    this.add(this.button);

    // Sync button focus and highlight state when parent receives focus
    this.on('focus', () => {
      this.button.focused = true;
      this.scene?.markDirty();
    });
    this.on('blur', () => {
      this.button.focused = false;
      this.scene?.markDirty();
    });

    this.on('click', () => this.toggleMenu());

    this.on('keydown', (e: any) => {
      const key = e.nativeEvent?.key;
      if (!key) return;

      if (key === 'ArrowDown' || key === 'ArrowUp') {
        e.preventDefault();
        e.nativeEvent?.stopImmediatePropagation();
        if (!this.activeMenu) {
          this.openMenu();
          this.highlightedIndex = this.options.indexOf(this.selectedValue);
          if (this.highlightedIndex === -1) this.highlightedIndex = 0;
        } else {
          const dir = key === 'ArrowDown' ? 1 : -1;
          this.highlightedIndex =
            (this.highlightedIndex + dir + this.options.length) % this.options.length;
        }
        this.updateMenuHighlight();
        this.scene?.markDirty();
      } else if (key === 'Enter' || key === ' ') {
        e.preventDefault();
        e.nativeEvent?.stopImmediatePropagation();
        if (!this.activeMenu) {
          this.openMenu();
        } else {
          if (this.highlightedIndex >= 0 && this.highlightedIndex < this.options.length) {
            this.selectOption(this.options[this.highlightedIndex]);
          }
        }
      } else if (key === 'Escape') {
        e.preventDefault();
        e.nativeEvent?.stopImmediatePropagation();
        if (this.activeMenu) {
          this.closeMenu();
        }
      }
    });

    this.on('change', (e: { value: string }) => {
      props.onChange?.(e.value);
    });
  }

  public getValue(): string {
    return this.selectedValue;
  }

  public getA11yAttributes() {
    return {
      role: 'combobox',
      label: this.label,
      expanded: this.activeMenu !== null,
      controls: this.activeMenu ? this.activeMenu.id : undefined,
      haspopup: 'listbox',
      value: this.selectedValue,
      activedescendant:
        this.activeMenu && this.highlightedIndex >= 0 && this.highlightedIndex < this.options.length
          ? `${this.id}-opt-${this.highlightedIndex}`
          : undefined,
    };
  }

  private toggleMenu() {
    if (this.activeMenu) {
      this.closeMenu();
    } else {
      this.openMenu();
    }
  }

  private openMenu() {
    const scene = this.scene;
    if (!scene) return;

    const triggerBounds = this.getWorldBounds();

    // Transparent backdrop covering full screen to intercept click-outside
    const backdrop = new (class Backdrop extends Entity {
      isPointInside() {
        return true;
      }
      render() {} // Invisible
    })('dropdown-backdrop');
    backdrop.width = scene.width;
    backdrop.height = scene.height;
    backdrop.interactive = true;

    // Stop clicks outside from reaching underlying controls
    backdrop.on('click', (e: VectoJSEvent) => {
      e.stopPropagation();
      this.closeMenu();
    });

    const menu = new Stack({ direction: 'vertical', gap: 2 });
    menu.x = triggerBounds.x;
    menu.y = triggerBounds.y + triggerBounds.height + 4;
    menu.width = triggerBounds.width;
    menu.height = this.options.length * 36 + (this.options.length - 1) * 2;
    menu.interactive = true;

    // Listbox semantic accessibility
    (menu as any).getA11yAttributes = () => ({
      role: 'listbox',
      label: 'Options',
    });

    this.options.forEach((opt, index) => {
      const item = new Button(opt, {
        bg: opt === this.selectedValue ? this.menuSelectedBg : this.menuBg,
        color: this.menuColor,
        radius: 4,
        font: '13px sans-serif',
        focusColor: this.focusColor,
      });
      item.id = `${this.id}-opt-${index}`;
      item.width = menu.width;
      item.height = 36;
      item.interactive = true;

      // Option attributes
      (item as any).getA11yAttributes = () => ({
        role: 'option',
        label: opt,
        selected: opt === this.selectedValue,
      });

      item.on('click', (e: VectoJSEvent) => {
        e.stopPropagation();
        this.selectOption(opt);
      });
      menu.add(item);
    });

    scene.showOverlay(backdrop);
    scene.showOverlay(menu);
    this.activeBackdrop = backdrop;
    this.activeMenu = menu;
    this.highlightedIndex = this.options.indexOf(this.selectedValue);
    this.updateMenuHighlight();
  }

  private updateMenuHighlight() {
    if (!this.activeMenu) return;
    this.activeMenu.children.forEach((child, idx) => {
      if (child instanceof Button) {
        child.bg =
          idx === this.highlightedIndex
            ? this.menuHighlightBg
            : child.label === this.selectedValue
              ? this.menuSelectedBg
              : this.menuBg;
      }
    });
  }

  private selectOption(opt: string) {
    this.selectedValue = opt;
    this.button.label = opt;
    this.emit('change', { value: opt });
    this.closeMenu();
  }

  private closeMenu() {
    const scene = this.scene;
    if (!scene) return;
    if (this.activeBackdrop) {
      scene.hideOverlay(this.activeBackdrop);
    }
    if (this.activeMenu) {
      scene.hideOverlay(this.activeMenu);
    }
    this.activeBackdrop = null;
    this.activeMenu = null;
    this.highlightedIndex = -1;
    this.scene?.markDirty();
  }

  public render(_r: any): void {}
}
