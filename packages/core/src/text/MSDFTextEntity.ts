import { Entity } from '../tree/Entity';
import { MSDFFont } from './MSDFFont';

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
  private color: string;
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
    this.text = text;
    this.font = options.font;
    this.texture = options.texture;
    this.fallbackFont = options.fallbackFont ?? 'sans-serif';
    this.fontSize = options.fontSize ?? 32;
    this.color = options.color ?? '#ffffff';
    this.letterSpacing = options.letterSpacing ?? 0;
    this.lineHeight = options.lineHeight;
  }

  public setText(text: string): void {
    this.text = text;
    // Triggers async layout coordination in later tasks
  }

  public isPointInside(globalX: number, globalY: number): boolean {
    if (!this.layoutResult) return false;
    const pos = this.getGlobalPosition();
    const scale = this.getWorldScale();
    const lx = (globalX - pos.x) / scale.x;
    const ly = (globalY - pos.y) / scale.y;
    return lx >= 0 && lx <= this.layoutResult.width && ly >= 0 && ly <= this.layoutResult.height;
  }

  public render(_renderer: any): void {}

  public destroy(): void {
    // Clean up async task states in later tasks
  }
}
