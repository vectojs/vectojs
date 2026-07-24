import { Entity, type ContentProjection } from '../tree/Entity';
import { MSDFFont } from '@vectojs/text';
import { LayoutWorkerManager } from '@vectojs/layout';

export interface MSDFTextEntityOptions {
  font: MSDFFont;
  texture: TexImageSource;
  fallbackFont?: string;
  fontSize?: number;
  color?: string;
  lineHeight?: number;
  letterSpacing?: number;
  /** Wrap boundary in logical pixels. Defaults to 1000. */
  maxWidth?: number;
  /** Layout height limit in logical pixels. Defaults to 1000. */
  maxHeight?: number;
  /**
   * Horizontal alignment. `'justify'` stretches every wrapped line flush to
   * {@link maxWidth} (the paragraph-final and newline-ended lines stay ragged);
   * `'left'` (default) leaves them ragged.
   */
  textAlign?: 'left' | 'justify';
}

export class MSDFTextEntity extends Entity {
  private font: MSDFFont;
  private texture: TexImageSource;
  private fallbackFont: string;
  private fontSize: number;
  public color: string;
  private letterSpacing: number;
  private lineHeight?: number;
  private maxWidth: number;
  private maxHeight: number;
  private textAlign: 'left' | 'justify';
  // Optional hyphenator. Runs on the MAIN thread (a function can't be
  // structure-cloned into the layout worker), turning each word into parts
  // joined by soft hyphens (U+00AD); the worker then treats those as break
  // opportunities. `text` keeps the original string for a11y/content
  // projection; `layoutText` is the soft-hyphen-annotated string sent to layout.
  private hyphenator: ((word: string) => string[]) | null = null;
  private layoutText: string = '';

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
    this.maxWidth = options.maxWidth ?? 1000;
    this.maxHeight = options.maxHeight ?? 1000;
    this.textAlign = options.textAlign ?? 'left';
    this.setText(text);
  }

  /** Change the wrap boundary and re-run layout for the current text. */
  public setMaxWidth(maxWidth: number): void {
    if (this.maxWidth === maxWidth) return;
    this.maxWidth = maxWidth;
    this.queueLayout();
  }

  /**
   * Set horizontal alignment (`'justify'` stretches wrapped lines flush to
   * {@link setMaxWidth}'s width; the last line stays ragged) and re-run layout.
   */
  public setTextAlign(align: 'left' | 'justify'): void {
    if (this.textAlign === align) return;
    this.textAlign = align;
    this.queueLayout();
  }

  /**
   * Plug a hyphenator (word → parts). Break opportunities are inserted as soft
   * hyphens (U+00AD) into the string sent to layout, so a word that doesn't fit
   * can break with a visible hyphen. Soft hyphens already present in the text
   * work without one. Pass `null` to disable. The original text is preserved
   * for accessibility — only the layout string carries the hyphens.
   */
  public setHyphenator(fn: ((word: string) => string[]) | null): void {
    this.hyphenator = fn;
    this.rebuildLayoutText();
    this.queueLayout();
  }

  public setText(text: string): void {
    if (this.text === text && this.layoutResult) return;
    this.text = text;
    this.rebuildLayoutText();
    this.queueLayout();
  }

  /**
   * Recompute {@link layoutText} from {@link text}: with a hyphenator active,
   * split each whitespace-delimited word and rejoin its parts with U+00AD so
   * the worker sees the break opportunities. Without one, the layout string is
   * the text unchanged.
   */
  private rebuildLayoutText(): void {
    if (!this.hyphenator) {
      this.layoutText = this.text;
      return;
    }
    const SHY = '\u00ad';
    // Split on runs of whitespace, keeping the separators so the reassembled
    // string is byte-identical to the original apart from inserted soft hyphens.
    this.layoutText = this.text.replace(/[^\s]+/g, (word) => {
      // Skip words that already contain a soft hyphen (author-controlled) or
      // are too short to be worth breaking.
      if (word.length <= 3 || word.includes(SHY)) return word;
      const parts = this.hyphenator!(word);
      return parts.length > 1 ? parts.join(SHY) : word;
    });
  }

  private queueLayout(): void {
    LayoutWorkerManager.getInstance().queueLayout(this.id, this.layoutText, {
      fontId: this.font.id,
      fontSize: this.fontSize,
      maxWidth: this.maxWidth,
      maxHeight: this.maxHeight,
      fontData: this.font.data,
      letterSpacing: this.letterSpacing,
      lineHeight: this.lineHeight,
      textAlign: this.textAlign,
      callback: (res) => {
        if (res.seqId < this.lastRenderedSeqId) return; // ignore stale responses
        this.lastRenderedSeqId = res.seqId;
        this.layoutResult = res;
        this.scene?.markDirty();
      },
    });
  }

  /**
   * Mirror the rendered text into the DOM content layer: find-in-page, screen
   * readers, crawlers, and translation see the same string the canvas draws.
   */
  public override getContentProjection(): ContentProjection | null {
    if (!this.text) return null;
    return {
      text: this.text,
      font: `${this.fontSize}px ${this.fallbackFont}`,
      lineHeight: this.lineHeight,
    };
  }

  public isPointInside(globalX: number, globalY: number): boolean {
    if (!this.layoutResult) return false;
    const local = this.worldToLocal(globalX, globalY);
    if (!local) return false;
    return (
      local.x >= 0 &&
      local.x <= this.layoutResult.width &&
      local.y >= 0 &&
      local.y <= this.layoutResult.height
    );
  }

  public render(renderer: any): void {
    if (!this.layoutResult) return;
    const scene = this.scene;
    const world = this.getWorldTransform();
    const worldScaleX = Math.hypot(world.a, world.b);
    const worldScaleY = Math.hypot(world.c, world.d);
    const orthogonalTolerance = Math.max(1, worldScaleX * worldScaleY) * 1e-6;
    const canUsePointGlyphs =
      Number.isFinite(worldScaleX) &&
      Number.isFinite(worldScaleY) &&
      world.a * world.d - world.b * world.c >= 0 &&
      Math.abs(world.a * world.c + world.b * world.d) <= orthogonalTolerance;

    // WebGL point rendering path
    if (scene && scene.pointRenderer && scene.glCanvas && canUsePointGlyphs) {
      scene.pointRenderer.setMSDFTexture(this.texture, this.font.distanceRange);

      const worldRot = Math.atan2(world.b, world.a);
      // The GL layer bypasses the 2D renderer's globalAlpha, so accumulate
      // ancestor opacity here (the Canvas2D fallback gets it from the Scene).
      let worldOpacity = this.opacity;
      for (let p = this.parent; p; p = p.parent) worldOpacity *= p.opacity;

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

        const lx = nodeX + pb.left * this.fontSize;
        const ly = nodeY - pb.top * this.fontSize;
        const glyphX = world.a * lx + world.c * ly + world.e;
        const glyphY = world.b * lx + world.d * ly + world.f;
        const glyphW = (pb.right - pb.left) * this.fontSize * worldScaleX;
        const glyphH = (pb.top - pb.bottom) * this.fontSize * worldScaleY;

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
          worldOpacity,
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
