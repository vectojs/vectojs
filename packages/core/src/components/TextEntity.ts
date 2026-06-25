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

  constructor(text: string, atlas: any, maxWidth: number, fontSize: number = 24) {
    super();
    this.text = text;
    this.atlas = atlas;
    this.fontSize = fontSize;
    this.layout = new LayoutEngine(maxWidth, 10000);
    this.updateLayout();

    // Enable Agent Accessibility Semantic Layer
    this.interactive = true;

    this.on('hover', () => (this.isHovered = true));
    this.on('pointerleave', () => (this.isHovered = false));
  }

  private updateLayout() {
    const result = this.layout.layoutText(this.text, this.atlas, this.fontSize);
    this.nodes = result.nodes;

    // Feed bounding box to A11y Layer
    this.width = result.totalWidth;
    this.height = result.totalHeight;
    // Bounding box offset: text is drawn downwards from baseline, so we adjust Y
    this.a11yOffsetY = 0;
  }

  public isPointInside(globalX: number, globalY: number): boolean {
    const pos = this.getGlobalPosition();
    const lx = globalX - pos.x;
    const ly = globalY - pos.y;
    return lx >= 0 && lx <= this.width && ly >= 0 && ly <= this.height;
  }

  public render(renderer: IRenderer): void {
    const currentFill = this.isHovered ? this.hoveredFillStyle : this.fillStyle;

    for (const node of this.nodes) {
      const glyph = this.atlas[node.char];

      if (!glyph) {
        renderer.save();
        renderer.translate(node.x, node.y + this.fontSize * 0.8); // Adjust baseline for native fillText
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
