import { type A11yAttributes, type IRenderer, type Scene } from '@vectojs/core';
import { Button, Card, Text, UIComponent } from '@vectojs/ui';
import type { AppDefinition } from './types';
import { addButtonIcon } from './icon';

export interface StartMenuChrome {
  bg: string;
  border: string;
  fg: string;
  hover: string;
  radius: number;
}

export interface StartMenuOptions {
  scene: Scene;
  apps: readonly AppDefinition[];
  chrome: StartMenuChrome;
  onLaunch: (appId: string) => void;
  onClose: () => void;
  /** Anchor: bottom-left of open menu (above taskbar) or top-left. */
  x: number;
  y: number;
  width?: number;
}

/**
 * Panel height for a given app count — shared with {@link DesktopShell}
 * so the shell's pre-positioning estimate can never drift from the real
 * layout math.
 */
export function startMenuHeight(appCount: number): number {
  const rowH = 36;
  const pad = 8;
  const headerH = 36;
  return headerH + pad + appCount * (rowH + 4) + pad;
}

/**
 * Plasma Kickoff-lite: vertical app list panel. Opens above/below the Start
 * button; Escape / outside click is handled by the shell.
 */
export class StartMenu extends UIComponent {
  private readonly chrome: StartMenuChrome;
  private readonly onLaunch: (appId: string) => void;
  private readonly onClose: () => void;
  private readonly panel: Card;

  constructor(opts: StartMenuOptions) {
    super();
    this.chrome = opts.chrome;
    this.onLaunch = opts.onLaunch;
    this.onClose = opts.onClose;

    const width = opts.width ?? 240;
    const rowH = 36;
    const pad = 8;
    const headerH = 36;
    const height = startMenuHeight(opts.apps.length);

    this.width = width;
    this.height = height;
    this.x = opts.x;
    this.y = opts.y;
    this.interactive = true;
    this.a11yProjection = 'eager';

    this.panel = new Card({
      width,
      height,
      bg: this.chrome.bg,
      border: this.chrome.border,
      radius: this.chrome.radius,
    });
    this.panel.interactive = false;
    this.panel.a11yProjection = 'never';
    this.panel.getA11yAttributes = () => ({ pointerEvents: 'none' });
    this.add(this.panel);

    const header = new Text('Applications', {
      font: '600 13px sans-serif',
      color: this.chrome.fg,
      selectable: false,
    });
    header.x = pad;
    header.y = 10;
    header.a11yProjection = 'never';
    header.interactive = false;
    this.panel.add(header);

    let y = headerH;
    for (const app of opts.apps) {
      const label = app.iconSvg ? app.title : app.icon ? `${app.icon}  ${app.title}` : app.title;
      const btn = new Button(label, {
        bg: this.chrome.bg,
        hoverBg: this.chrome.hover,
        color: this.chrome.fg,
        font: '600 13px sans-serif',
        padding: 8,
        radius: 6,
        width: width - pad * 2,
        height: rowH,
        onClick: () => {
          this.onLaunch(app.id);
          this.onClose();
        },
      });
      if (app.iconSvg) {
        addButtonIcon(btn, app.iconSvg, 18, this.chrome.fg);
        btn.width = width - pad * 2;
        const original = btn.getA11yAttributes.bind(btn);
        btn.getA11yAttributes = () => ({ ...original(), label: app.title });
      }
      btn.a11yProjection = 'eager';
      btn.x = pad;
      btn.y = y;
      this.panel.add(btn);
      y += rowH + 4;
    }
  }

  public override getA11yAttributes(): A11yAttributes {
    return { role: 'menu', label: 'Start menu', pointerEvents: 'none' };
  }

  public override render(_r: IRenderer): void {}
}
