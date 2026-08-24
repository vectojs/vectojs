import { Entity, type ContentProjection, type ContentProjectionLine } from '../tree/Entity';
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
  /** Bumped by {@link queueLayout}; read by `Scene` to skip an unchanged sync. */
  private contentEpoch = 0;
  // Atlas-decode subscription (see watchAtlasDecode). Held so `destroy()` can
  // release it: the handler closes over `this`, so leaving it attached to a
  // long-lived shared atlas image would retain the whole entity.
  private atlasDecodeTarget: EventTarget | null = null;
  private atlasDecodeHandler: (() => void) | null = null;
  private fontStringCache: string[] = [];
  private layoutResult: {
    width: number;
    height: number;
    codePoints: Uint32Array;
    xCoords: Float32Array;
    yCoords: Float32Array;
    packedStyles: Uint32Array;
  } | null = null;

  /**
   * Visual rows rebuilt from {@link layoutResult} (see
   * {@link rebuildProjectionLines}). Empty until a layout reply lands and the
   * reply's shaped glyphs can be mapped back to the source text 1:1.
   */
  private projectionLines: ContentProjectionLine[] = [];

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
    this.watchAtlasDecode();
    this.setText(text);
  }

  /**
   * Repaint once the atlas raster decodes.
   *
   * The WebGL backend refuses to upload a not-yet-decoded atlas (it would pin an
   * empty texture in its identity cache forever), so the upload has to happen on
   * a LATER frame — and nothing else schedules one. Layout marks the scene dirty
   * when the worker replies, which for a network-served atlas is long before the
   * image lands, so the scene is already idle by then.
   *
   * Measured on Chromium and Firefox (2026-07-31) with a 600 ms atlas: the
   * scene's own rAF loop never uploaded a decoded atlas in EITHER render mode.
   * `onDemand` skips idle frames outright; `always` throttles to the idle FPS
   * floor when idle, so whether it recovers is down to whether a throttled tick happens to
   * land after the decode — Chromium got one, Firefox did not. Neither is a
   * mechanism, which is why this listener exists rather than relying on the
   * frame loop to come back around.
   *
   * Only `HTMLImageElement`-shaped sources have a decode to wait for; a canvas,
   * `ImageBitmap`, or `VideoFrame` atlas is ready on arrival.
   */
  private watchAtlasDecode(): void {
    const source = this.texture as {
      addEventListener?: unknown;
      removeEventListener?: unknown;
      complete?: unknown;
      naturalWidth?: unknown;
    };
    if (
      typeof source.complete !== 'boolean' ||
      typeof source.addEventListener !== 'function' ||
      typeof source.removeEventListener !== 'function'
    ) {
      return;
    }
    // Already decoded: the first render uploads it, nothing to wait for.
    if (source.complete && typeof source.naturalWidth === 'number' && source.naturalWidth > 0) {
      return;
    }
    const target = this.texture as unknown as EventTarget;
    this.atlasDecodeHandler = () => {
      this.detachAtlasDecodeListener();
      this.scene?.markDirty();
    };
    // `error` is registered too, purely so the listener is released on a 404
    // instead of being retained for the entity's lifetime.
    target.addEventListener('load', this.atlasDecodeHandler);
    target.addEventListener('error', this.atlasDecodeHandler);
    this.atlasDecodeTarget = target;
  }

  private detachAtlasDecodeListener(): void {
    if (!this.atlasDecodeTarget || !this.atlasDecodeHandler) return;
    this.atlasDecodeTarget.removeEventListener('load', this.atlasDecodeHandler);
    this.atlasDecodeTarget.removeEventListener('error', this.atlasDecodeHandler);
    this.atlasDecodeTarget = null;
    this.atlasDecodeHandler = null;
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
    // The projection reports `text` + `fontSize` + `lineHeight`, and every
    // mutator that can change any of them ends here.
    this.contentEpoch++;
    // A reply from a PREVIOUS queue could still be in flight with geometry for
    // the old text; project the coarse fallback until the fresh reply lands,
    // or the Scene would pair new text with stale line carriers.
    this.projectionLines = [];
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
        // The layout reply is what can turn the projection from "text + font
        // only" into per-line geometry; without an epoch bump here the Scene
        // would early-return on the unchanged epoch and the DOM carriers would
        // never materialize (only a repaint is scheduled by markDirty).
        this.contentEpoch++;
        this.rebuildProjectionLines();
        this.scene?.markDirty();
      },
    });
  }

  /**
   * Mirror the rendered text into the DOM content layer: find-in-page, screen
   * readers, crawlers, and translation see the same string the canvas draws.
   *
   * `baseline` + `lineHeight` are always emitted (they come from the font
   * metrics, no layout reply needed), so the DOM line boxes at least land on
   * the canvas rhythm: the first baseline at `ascender × fontSize` and every
   * row advancing `(ascender − descender) × fontSize`. Once a layout reply is
   * in AND its shaped glyphs map back to the source 1:1 (unshaped LTR text —
   * bidi, shaping, soft hyphens or `\r` all fall back to the coarse branch),
   * per-line carriers pin each row's baseline exactly to the painted glyphs.
   */
  public override getContentProjection(): ContentProjection | null {
    if (!this.text) return null;
    const metrics = this.font.data.metrics;
    // Descender is stored NEGATIVE (msdfLayout.ts reads it the same way).
    const asc = metrics?.ascender ?? 0.8;
    const desc = metrics?.descender ?? -0.2;
    const actualLineHeight = this.lineHeight ?? this.fontSize * (asc - desc);
    return {
      text: this.text,
      font: `${this.fontSize}px ${this.fallbackFont}`,
      lineHeight: actualLineHeight,
      baseline: asc * this.fontSize,
      lines: this.projectionLines.length > 0 ? this.projectionLines : undefined,
    };
  }

  /**
   * Group the worker's positioned glyphs into the same visual rows the canvas
   * draws. Only runs when the reply's glyph sequence equals the source string
   * (one glyph per source char, no bidi reordering, no shaping, no soft
   * hyphens, no `\r`) — only then do glyph offsets line up with source offsets
   * byte-for-byte, which is what keeps find-in-page and the Scene's dev-mode
   * equality check correct. Every other text falls back to the coarse branch's
   * `baseline` + `lineHeight`, which still pins the row rhythm.
   */
  private rebuildProjectionLines(): void {
    const res = this.layoutResult;
    if (!res) {
      this.projectionLines = [];
      return;
    }
    const shaped: string[] = [];
    for (let i = 0; i < res.codePoints.length; i++) {
      shaped.push(String.fromCodePoint(res.codePoints[i]));
    }
    // Glyphs are the source minus its newlines, 1:1 in order — a hard break
    // advances the line without emitting a glyph.
    const sourceWithoutNewlines = this.text.replace(/\n/g, '');
    if (
      this.textAlign !== 'left' ||
      shaped.join('') !== sourceWithoutNewlines ||
      res.yCoords.length !== res.codePoints.length
    ) {
      this.projectionLines = [];
      return;
    }

    const metrics = this.font.data.metrics;
    const asc = metrics?.ascender ?? 0.8;
    const desc = metrics?.descender ?? -0.2;
    const actualLineHeight = this.lineHeight ?? this.fontSize * (asc - desc);
    const baseline = asc * this.fontSize;

    // Glyph index → source index. Newlines are not glyphs, so the k-th glyph
    // is the k-th non-newline source character.
    const srcIdx: number[] = [];
    for (let i = 0; i < this.text.length; i++) {
      if (this.text[i] !== '\n') srcIdx.push(i);
    }

    const glyphsByLine = new Map<number, number[]>();
    let maxIdx = -1;
    for (let i = 0; i < res.yCoords.length; i++) {
      const idx = Math.round((res.yCoords[i] - baseline) / actualLineHeight);
      const list = glyphsByLine.get(idx) ?? [];
      list.push(i);
      glyphsByLine.set(idx, list);
      if (idx > maxIdx) maxIdx = idx;
    }

    // First pass: each row's source extent (start = first glyph's source
    // index, end = one past the last glyph's), so a row's separator can pair
    // with the IMMEDIATE next row's start — blank rows included.
    const starts: number[] = [];
    const ends: number[] = [];
    let previousEnd = 0;
    for (let i = 0; i <= maxIdx; i++) {
      const glyphs = glyphsByLine.get(i) ?? [];
      const start = glyphs.length > 0 ? srcIdx[glyphs[0]] : previousEnd;
      const end = glyphs.length > 0 ? srcIdx[glyphs[glyphs.length - 1]] + 1 : start;
      starts.push(start);
      ends.push(end);
      previousEnd = Math.max(previousEnd, end);
    }

    const lines: ContentProjectionLine[] = [];
    for (let i = 0; i <= maxIdx; i++) {
      const start = starts[i];
      const end = ends[i];
      const nextStart = i + 1 <= maxIdx ? starts[i + 1] : this.text.length;
      lines.push({
        text: this.text.slice(start, Math.max(start, end)),
        separatorAfter: this.text.slice(end, Math.max(end, nextStart)),
        // Left-aligned LTR glyphs start at x 0. No perGraphemeCarriers: the
        // DOM measures the FALLBACK font, not the atlas font, so natural flow
        // at the fallback's own advances stays self-consistent (pin carriers
        // to atlas x and the fallback text would misalign instead).
        x: 0,
        y: i * actualLineHeight,
        baseline,
        font: `${this.fontSize}px ${this.fallbackFont}`,
        lineHeight: actualLineHeight,
      });
    }
    this.projectionLines = lines;
  }

  public override getContentEpoch(): number {
    return this.contentEpoch;
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

        // Draw-time tint from `color`: the layout worker packs every glyph's
        // color bits white, so deriving the tint from packedStyle would ignore
        // the option entirely. Both backends parse any CSS color string.
        scene.pointRenderer.addGlyph(
          glyphX,
          glyphY,
          glyphW,
          glyphH,
          ab.left / aw,
          v0,
          ab.right / aw,
          v1,
          this.color,
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

      // Color bits of packedStyle are worker-packed white (see the WebGL path
      // comment); bold/italic flags still come from the low two bits.
      const fontString = this.fontStringCache[packedStyle & 3];

      renderer.fillText(String.fromCodePoint(code), nodeX, nodeY, fontString, this.color);
    }
  }

  public destroy(): void {
    // Static guard: never resurrect the worker singleton (or throw in SSR)
    // just to cancel — if no manager exists, nothing is queued for this entity.
    LayoutWorkerManager.cancelLayoutForEntity(this.id);
    this.detachAtlasDecodeListener();
    super.destroy();
  }
}
