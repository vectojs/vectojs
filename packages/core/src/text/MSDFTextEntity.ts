import { Entity } from '../tree/Entity';
import { MSDFFont } from './MSDFFont';
import { LayoutWorkerManager } from '../layout/LayoutWorkerManager';

export interface MSDFTextEntityOptions {
  font: MSDFFont;
  texture: TexImageSource;
  fallbackFont?: string;
  fontSize?: number;
  color?: string;
  lineHeight?: number;
  letterSpacing?: number;
}

export class MSDFTextEntity extends Entity {
  private font: MSDFFont;
  private texture: TexImageSource;
  private fallbackFont: string;
  private fontSize: number;
  public color: string;
  private letterSpacing: number;
  private lineHeight?: number;

  private text: string = '';
  private lastRenderedSeqId: number = 0;
  private rgbColorCache: Map<number, string> = new Map();
  private fontStringCache: string[] = [];

  private layoutResult: {
    width: number;
    height: number;
    codePoints: Uint32Array;
    xCoords: Float32Array;
    yCoords: Float32Array;
    packedStyles: Uint32Array;
  } | null = null;

  constructor(text: string, options: MSDFTextEntityOptions) {
    super();
    this.font = options.font;
    this.texture = options.texture;
    this.fallbackFont = options.fallbackFont ?? 'sans-serif';
    this.fontSize = options.fontSize ?? 32;
    this.color = options.color ?? '#ffffff';
    this.letterSpacing = options.letterSpacing ?? 0;
    this.lineHeight = options.lineHeight;
    this.setText(text);
  }

  public setText(text: string): void {
    if (this.text === text && this.layoutResult) return;
    this.text = text;

    LayoutWorkerManager.getInstance().queueLayout(this.id, this.text, {
      fontId: this.font.id,
      fontSize: this.fontSize,
      maxWidth: 1000, // standard wrap boundary
      maxHeight: 1000,
      fontData: this.font.data,
      letterSpacing: this.letterSpacing,
      lineHeight: this.lineHeight,
      callback: (res) => {
        if (res.seqId < this.lastRenderedSeqId) return; // ignore stale responses
        this.lastRenderedSeqId = res.seqId;
        this.layoutResult = res;
        this.scene?.markDirty();
      },
    });
  }

  public isPointInside(globalX: number, globalY: number): boolean {
    if (!this.layoutResult) return false;
    const pos = this.getGlobalPosition();
    const scale = this.getWorldScale();
    const lx = (globalX - pos.x) / scale.x;
    const ly = (globalY - pos.y) / scale.y;
    return lx >= 0 && lx <= this.layoutResult.width && ly >= 0 && ly <= this.layoutResult.height;
  }

  public getWorldRotation(): number {
    let rot = this.rotation;
    let curr = this.parent;
    while (curr && curr.id !== 'root') {
      rot += curr.rotation;
      curr = curr.parent;
    }
    return rot;
  }

  public render(renderer: any): void {
    if (!this.layoutResult) return;
    const scene = this.scene;

    // WebGL point rendering path
    if (scene && scene.pointRenderer && scene.glCanvas) {
      scene.pointRenderer.setMSDFTexture(this.texture, this.font.distanceRange);

      const globalPos = this.getGlobalPosition();
      const scale = this.getWorldScale();
      const worldRot = this.getWorldRotation();
      const rCos = Math.cos(worldRot);
      const rSin = Math.sin(worldRot);

      const len = this.layoutResult.codePoints.length;
      for (let i = 0; i < len; i++) {
        const code = this.layoutResult.codePoints[i];
        const nodeX = this.layoutResult.xCoords[i];
        const nodeY = this.layoutResult.yCoords[i];
        const packedStyle = this.layoutResult.packedStyles[i];

        const def = this.font.getGlyph(code);
        if (!def || !def.atlasBounds || !def.planeBounds) continue;

        const { atlasBounds: ab, planeBounds: pb } = def;
        const aw = this.font.atlasWidth;
        const ah = this.font.atlasHeight;

        // Position coordinates calculated and rotated in world space
        const lx = (nodeX + pb.left * this.fontSize) * scale.x;
        const ly = (nodeY - pb.top * this.fontSize) * scale.y;

        const glyphX = globalPos.x + lx * rCos - ly * rSin;
        const glyphY = globalPos.y + lx * rSin + ly * rCos;
        const glyphW = (pb.right - pb.left) * this.fontSize * scale.x;
        const glyphH = (pb.top - pb.bottom) * this.fontSize * scale.y;

        const v0 = this.font.data.atlas.yOrigin === 'bottom' ? 1 - ab.top / ah : ab.top / ah;
        const v1 = this.font.data.atlas.yOrigin === 'bottom' ? 1 - ab.bottom / ah : ab.bottom / ah;

        const colorVal = packedStyle >>> 8;
        let runColor = this.rgbColorCache.get(colorVal);
        if (!runColor) {
          const r = (colorVal >> 16) & 0xff;
          const g = (colorVal >> 8) & 0xff;
          const b = colorVal & 0xff;
          runColor = `rgb(${r},${g},${b})`;
          this.rgbColorCache.set(colorVal, runColor);
        }

        scene.pointRenderer.addGlyph(
          glyphX,
          glyphY,
          glyphW,
          glyphH,
          ab.left / aw,
          v0,
          ab.right / aw,
          v1,
          runColor,
          this.opacity,
          worldRot,
        );
      }
      return;
    }

    // Canvas2D Fallback Path: 0-GC fontString caching
    if (this.fontStringCache.length === 0) {
      this.fontStringCache[0] = `${this.fontSize}px ${this.fallbackFont}`; // normal
      this.fontStringCache[1] = `bold ${this.fontSize}px ${this.fallbackFont}`; // bold (bit 0)
      this.fontStringCache[2] = `italic ${this.fontSize}px ${this.fallbackFont}`; // italic (bit 1)
      this.fontStringCache[3] = `italic bold ${this.fontSize}px ${this.fallbackFont}`; // bold + italic
    }

    const len = this.layoutResult.codePoints.length;
    for (let i = 0; i < len; i++) {
      const code = this.layoutResult.codePoints[i];
      const nodeX = this.layoutResult.xCoords[i];
      const nodeY = this.layoutResult.yCoords[i];
      const packedStyle = this.layoutResult.packedStyles[i];

      const fontString = this.fontStringCache[packedStyle & 3];
      const colorVal = packedStyle >>> 8;
      let runColor = this.rgbColorCache.get(colorVal);
      if (!runColor) {
        const r = (colorVal >> 16) & 0xff;
        const g = (colorVal >> 8) & 0xff;
        const b = colorVal & 0xff;
        runColor = `rgb(${r},${g},${b})`;
        this.rgbColorCache.set(colorVal, runColor);
      }

      renderer.fillText(String.fromCodePoint(code), nodeX, nodeY, fontString, runColor);
    }
  }

  public destroy(): void {
    LayoutWorkerManager.getInstance().cancelLayout(this.id);
    super.destroy();
  }
}
