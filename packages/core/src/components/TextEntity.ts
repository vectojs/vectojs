import { Entity } from '../tree/Entity';
// @ts-ignore
import { LayoutEngine } from '../layout/LayoutEngine.js';
import { IRenderer } from '../renderer/IRenderer';

export class TextEntity extends Entity {
  public text: string;
  private atlas: any;
  private layout: LayoutEngine;
  private nodes: any[] = [];
  public fontSize: number;

  public fillStyle: string | any = '#94a3b8';
  public strokeStyle: string | any = null;
  public hoveredFillStyle: string | any = '#ffffff';
  public lineWidth: number = 1;

  private isHovered: boolean = false;
  private hiddenDom: HTMLDivElement | null = null;
  private canvasParent: HTMLElement | null = null;

  constructor(text: string, atlas: any, width: number, fontSize: number = 24) {
    super();
    this.text = text;
    this.atlas = atlas;
    this.fontSize = fontSize;
    this.layout = new LayoutEngine(width, 10000);
    this.updateLayout();

    this.on('hover', () => {
      this.isHovered = true;
      document.body.style.cursor = 'pointer';
    });
    this.on('pointerleave', () => {
      this.isHovered = false;
      document.body.style.cursor = 'default';
    });
  }

  private updateLayout() {
    const result = this.layout.layoutText(this.text, this.atlas, this.fontSize);
    this.nodes = result.nodes;
  }

  public setupHiddenDOM(canvasParent: HTMLElement) {
    this.canvasParent = canvasParent;
    if (!this.hiddenDom) {
      this.hiddenDom = document.createElement('div');
      this.hiddenDom.style.position = 'absolute';
      this.hiddenDom.style.color = 'rgba(255, 255, 255, 0.1)'; // Slightly visible to prove it exists
      this.hiddenDom.style.pointerEvents = 'auto'; // allow selection
      this.hiddenDom.style.userSelect = 'text';
      this.hiddenDom.style.whiteSpace = 'pre-wrap';
      this.hiddenDom.style.zIndex = '-1';
      canvasParent.appendChild(this.hiddenDom);
    }
    this.hiddenDom.textContent = this.text;
    const pos = this.getGlobalPosition();
    this.hiddenDom.style.left = `${pos.x}px`;
    this.hiddenDom.style.top = `${pos.y - this.fontSize}px`;
    this.hiddenDom.style.fontSize = `${this.fontSize}px`;
    this.hiddenDom.style.width = `${this.layout.width}px`;
    this.hiddenDom.style.lineHeight = `1.2`;
  }

  public isPointInside(globalX: number, globalY: number): boolean {
    const pos = this.getGlobalPosition();
    const lx = globalX - pos.x;
    const ly = globalY - pos.y;

    for (const node of this.nodes) {
      if (
        lx >= node.x &&
        lx <= node.x + this.fontSize &&
        ly >= node.y - this.fontSize &&
        ly <= node.y
      ) {
        return true;
      }
    }
    return false;
  }

  public render(renderer: IRenderer): void {
    const currentFill = this.isHovered ? this.hoveredFillStyle : this.fillStyle;

    // Sync hidden DOM with animations
    if (this.hiddenDom) {
      const pos = this.getGlobalPosition();
      this.hiddenDom.style.left = `${pos.x}px`;
      this.hiddenDom.style.top = `${pos.y - this.fontSize}px`;
    }

    for (const node of this.nodes) {
      const glyph = this.atlas[node.char];

      // EMOJI / MISSING GLYPH FALLBACK!
      if (!glyph) {
        renderer.save();
        renderer.translate(node.x, node.y);
        renderer.fillText(node.char, 0, 0, `${this.fontSize}px sans-serif`, currentFill);
        renderer.restore();
        continue;
      }

      renderer.save();
      renderer.translate(node.x, node.y);

      const scale = this.fontSize / glyph.baseSize;
      renderer.scale(scale, scale);

      for (const path of glyph.ast.paths) {
        renderer.beginPath();
        for (const cmd of path.commands) {
          if (cmd.type === 'M') renderer.moveTo(cmd.x, cmd.y);
          else if (cmd.type === 'L') renderer.lineTo(cmd.x, cmd.y);
          else if (cmd.type === 'C')
            renderer.bezierCurveTo(cmd.x1, cmd.y1, cmd.x2, cmd.y2, cmd.x, cmd.y);
          else if (cmd.type === 'Z') renderer.closePath();
        }

        if (currentFill) {
          renderer.fill(currentFill);
        }
        if (this.strokeStyle) {
          renderer.stroke(this.strokeStyle, this.lineWidth / scale);
        }
      }
      renderer.restore();
    }
  }
}
