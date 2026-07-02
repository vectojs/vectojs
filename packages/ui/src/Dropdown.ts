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

  constructor(options: string[], props: any = {}) {
    super(props);
    this.options = options;
    this.selectedValue = props.value ?? (options.length > 0 ? options[0] : '');
    this.interactive = true;

    this.width = props.width ?? 120;
    this.height = props.height ?? 36;

    this.button = new Button(this.selectedValue, {
      bg: props.bg ?? 'rgba(30, 41, 59, 0.85)',
      color: props.color ?? '#fff',
      radius: props.radius ?? 8,
      font: props.font ?? '14px sans-serif',
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

  public getA11yAttributes() {
    return {
      role: 'combobox',
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

    const globalPos = this.getGlobalPosition();

    // Transparent backdrop covering full screen to intercept click-outside
    const backdrop = new (class Backdrop extends Entity {
      isPointInside() {
        return true;
      }
      render() {} // Invisible
    })('dropdown-backdrop');
    backdrop.width = typeof window !== 'undefined' ? window.innerWidth : 800;
    backdrop.height = typeof window !== 'undefined' ? window.innerHeight : 600;
    backdrop.interactive = true;

    // Stop clicks outside from reaching underlying controls
    backdrop.on('click', (e: VectoJSEvent) => {
      e.stopPropagation();
      this.closeMenu();
    });

    const menu = new Stack({ direction: 'vertical', gap: 2 });
    menu.x = globalPos.x;
    menu.y = globalPos.y + this.height + 4;
    menu.width = this.width;
    menu.height = this.options.length * 36 + (this.options.length - 1) * 2;
    menu.interactive = true;

    // Listbox semantic accessibility
    (menu as any).getA11yAttributes = () => ({
      role: 'listbox',
      label: 'Options',
    });

    this.options.forEach((opt, index) => {
      const item = new Button(opt, {
        bg: opt === this.selectedValue ? 'rgba(0, 240, 255, 0.25)' : 'rgba(15, 23, 42, 0.95)',
        color: '#fff',
        radius: 4,
        font: '13px sans-serif',
      });
      item.id = `${this.id}-opt-${index}`;
      item.width = this.width;
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
            ? 'rgba(0, 240, 255, 0.4)'
            : child.label === this.selectedValue
              ? 'rgba(0, 240, 255, 0.25)'
              : 'rgba(15, 23, 42, 0.95)';
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
