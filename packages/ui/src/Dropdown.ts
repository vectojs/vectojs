import { Entity, VectoUIEvent } from '@vecto-ui/core';
import { UIComponent } from './UIComponent';
import { Button } from './Button';
import { Stack } from './Stack';

export class Dropdown extends UIComponent {
  private options: string[];
  private selectedValue: string;
  private button: Button;
  private activeMenu: Entity | null = null;
  private activeBackdrop: Entity | null = null;

  constructor(options: string[], props: any = {}) {
    super(props);
    this.options = options;
    this.selectedValue = props.value ?? (options.length > 0 ? options[0] : '');
    this.interactive = true;

    this.width = props.width ?? 120;
    this.height = props.height ?? 36;

    this.button = new Button(this.selectedValue, {
      width: this.width,
      height: this.height,
      bg: props.bg ?? 'rgba(30, 41, 59, 0.85)',
      color: props.color ?? '#fff',
      radius: props.radius ?? 8,
      font: props.font ?? '14px sans-serif',
    });
    this.add(this.button);

    this.on('click', () => this.toggleMenu());
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
    backdrop.width = window.innerWidth;
    backdrop.height = window.innerHeight;
    backdrop.interactive = true;

    // Stop clicks outside from reaching underlying controls
    backdrop.on('click', (e: VectoUIEvent) => {
      e.stopPropagation();
      this.closeMenu();
    });

    const menu = new Stack({ direction: 'vertical', gap: 2 });
    menu.x = globalPos.x;
    menu.y = globalPos.y + this.height + 4;
    menu.width = this.width;

    this.options.forEach((opt) => {
      const item = new Button(opt, {
        width: this.width,
        height: 36,
        bg: opt === this.selectedValue ? 'rgba(0, 240, 255, 0.25)' : 'rgba(15, 23, 42, 0.95)',
        color: '#fff',
        radius: 4,
        font: '13px sans-serif',
      });
      item.on('click', (e: VectoUIEvent) => {
        e.stopPropagation();
        this.selectedValue = opt;
        this.button.label = opt;
        this.emit('change', { value: opt });
        this.closeMenu();
      });
      menu.add(item);
    });

    scene.showOverlay(backdrop);
    scene.showOverlay(menu);
    this.activeBackdrop = backdrop;
    this.activeMenu = menu;
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
  }
}
