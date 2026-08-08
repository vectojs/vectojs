import {
  contentLineInHint,
  type ContentProjection,
  type ContentProjectionHint,
  GlyphRasterAtlas,
  type GlyphRasterAtlasStats,
  IRenderer,
  prepareContentGrid,
  type PreparedContentGrid,
} from '@vectojs/core';
import { measureText, UIComponent } from '@vectojs/ui';

import { resolvePresetTheme, type MarkdownThemePresetName } from './markdown-presets';
import type { MarkdownTheme } from './theme';

/**
 * Fenced code blocks: the keyword tables, the per-line highlighter, the
 * `CodeBlock` entity and its shared glyph atlas.
 *
 * Self-contained apart from a type-only edge to `./theme`, so this module has no
 * runtime dependency on `Markdown.ts` and `CodeBlock` can be constructed without
 * loading the component. See `forge/decisions/file-decomposition-2026-08.md`.
 */

/** Keyword sets for basic syntax highlighting. */
const KEYWORD_SETS: Record<string, Set<string>> = {
  js: new Set([
    'const',
    'let',
    'var',
    'function',
    'return',
    'if',
    'else',
    'for',
    'while',
    'class',
    'extends',
    'new',
    'this',
    'import',
    'export',
    'from',
    'default',
    'async',
    'await',
    'try',
    'catch',
    'throw',
    'of',
    'in',
    'typeof',
    'instanceof',
    'switch',
    'case',
    'break',
    'continue',
    'null',
    'undefined',
    'true',
    'false',
  ]),
  ts: new Set([
    'const',
    'let',
    'var',
    'function',
    'return',
    'if',
    'else',
    'for',
    'while',
    'class',
    'extends',
    'new',
    'this',
    'import',
    'export',
    'from',
    'default',
    'async',
    'await',
    'try',
    'catch',
    'throw',
    'of',
    'in',
    'typeof',
    'instanceof',
    'switch',
    'case',
    'break',
    'continue',
    'null',
    'undefined',
    'true',
    'false',
    'type',
    'interface',
    'enum',
    'as',
    'is',
    'readonly',
    'implements',
    'abstract',
    'public',
    'private',
    'protected',
    'static',
    'void',
    'never',
    'any',
    'unknown',
  ]),
  py: new Set([
    'def',
    'class',
    'return',
    'if',
    'elif',
    'else',
    'for',
    'while',
    'import',
    'from',
    'as',
    'with',
    'try',
    'except',
    'raise',
    'finally',
    'pass',
    'break',
    'continue',
    'and',
    'or',
    'not',
    'in',
    'is',
    'None',
    'True',
    'False',
    'yield',
    'lambda',
    'global',
    'nonlocal',
    'del',
    'assert',
    'async',
    'await',
  ]),
  rust: new Set([
    'fn',
    'let',
    'mut',
    'const',
    'if',
    'else',
    'for',
    'while',
    'loop',
    'match',
    'return',
    'struct',
    'enum',
    'impl',
    'trait',
    'pub',
    'use',
    'mod',
    'crate',
    'self',
    'super',
    'where',
    'as',
    'in',
    'ref',
    'move',
    'async',
    'await',
    'true',
    'false',
    'type',
    'unsafe',
    'extern',
    'dyn',
    'static',
  ]),
};

// Aliases
KEYWORD_SETS['javascript'] = KEYWORD_SETS['js'];
KEYWORD_SETS['typescript'] = KEYWORD_SETS['ts'];
KEYWORD_SETS['python'] = KEYWORD_SETS['py'];
KEYWORD_SETS['rs'] = KEYWORD_SETS['rust'];

/** Segment of highlighted code text. */
interface CodeSegment {
  text: string;
  color: string;
}

/** Tokenize a line of code into colored segments (keyword / string / comment / default). */
function highlightLine(line: string, lang: string, theme: Required<MarkdownTheme>): CodeSegment[] {
  const keywords = KEYWORD_SETS[lang];
  if (!keywords) {
    return [{ text: line, color: theme.codeColor }];
  }

  const segments: CodeSegment[] = [];
  const KEYWORD_COLOR = theme.syntaxKeywordColor;
  const STRING_COLOR = theme.syntaxStringColor;
  const COMMENT_COLOR = theme.syntaxCommentColor;
  const NUMBER_COLOR = theme.syntaxNumberColor;

  let i = 0;
  let buf = '';

  const flush = (color: string) => {
    if (buf) {
      segments.push({ text: buf, color });
      buf = '';
    }
  };

  while (i < line.length) {
    const ch = line[i];

    // Single-line comment
    if (ch === '/' && line[i + 1] === '/') {
      flush(theme.codeColor);
      segments.push({ text: line.slice(i), color: COMMENT_COLOR });
      return segments;
    }
    // Python / Rust comment
    if (ch === '#' && (lang === 'py' || lang === 'python' || lang === 'rust' || lang === 'rs')) {
      flush(theme.codeColor);
      segments.push({ text: line.slice(i), color: COMMENT_COLOR });
      return segments;
    }

    // Strings. Only colored when the quote actually CLOSES on this line —
    // otherwise a stray quote (a Rust lifetime `&'a str`, an apostrophe in an
    // identifier or trailing prose, a generic `'` in shell) would swallow the
    // whole rest of the line as a green "string". An unterminated quote falls
    // through and is treated as ordinary punctuation.
    if (ch === '"' || ch === "'" || ch === '`') {
      const quote = ch;
      let j = i + 1;
      let closed = false;
      while (j < line.length) {
        if (line[j] === '\\') {
          j += 2; // skip the escape and whatever it escapes
          continue;
        }
        if (line[j] === quote) {
          closed = true;
          break;
        }
        j++;
      }
      if (closed) {
        flush(theme.codeColor);
        segments.push({ text: line.slice(i, j + 1), color: STRING_COLOR });
        i = j + 1; // past the closing quote
        continue;
      }
      // Unterminated: emit as plain text and move on.
      buf += ch;
      i++;
      continue;
    }

    // Numbers
    if (/\d/.test(ch) && (i === 0 || /[\s(,=+\-*/<>[\]{}:;]/.test(line[i - 1]))) {
      flush(theme.codeColor);
      let j = i;
      while (j < line.length && /[\d._xXa-fA-F]/.test(line[j])) j++;
      segments.push({ text: line.slice(i, j), color: NUMBER_COLOR });
      i = j;
      continue;
    }

    // Word boundaries (potential keywords)
    if (/[a-zA-Z_]/.test(ch)) {
      flush(theme.codeColor);
      let j = i;
      while (j < line.length && /[a-zA-Z0-9_]/.test(line[j])) j++;
      const word = line.slice(i, j);
      segments.push({
        text: word,
        color: keywords.has(word) ? KEYWORD_COLOR : theme.codeColor,
      });
      i = j;
      continue;
    }

    buf += ch;
    i++;
  }

  flush(theme.codeColor);
  return segments;
}

// ── Single CodeBlock entity ─────────────────────────────────────────────────

/**
 * A single self-rendering entity for fenced code blocks.
 *
 * Replaces the old N×M child-entity explosion (Container → Stack → Text per
 * segment per line) with a flat leaf that draws its own background + text.
 */
export class CodeBlock extends UIComponent {
  private lines: CodeSegment[][];
  private grid: PreparedContentGrid | null = null;
  /** Raw (unhighlighted) lines of the last build, for prefix reuse in buildLines. */
  private rawLines: string[] | null = null;
  private cellWidth = 0;
  private source: string;
  /** Bumped by {@link buildLines} and {@link setSelectable}; read by `Scene`. */
  private contentEpoch = 0;

  private lang: string;
  private theme: Required<MarkdownTheme>;
  /**
   * Assigned in the constructor rather than as a field initializer: both come
   * from `theme`, and a field initializer runs before the constructor body has
   * a `theme` to read.
   */
  private lineH: number;
  private pad: number;
  private codeFont: string;
  public selectable: boolean;

  /**
   * @param theme Any subset of {@link MarkdownTheme}, or the name of a built-in
   *   preset (see {@link MarkdownThemePresetName}). Accepting a partial theme
   *   keeps callers that were written against an earlier, smaller
   *   `MarkdownTheme` working — this class is public API, and a hand-built
   *   theme literal would otherwise start throwing
   *   `lineHeight must be a positive finite number` the moment a new size key
   *   was added. Resolved through {@link resolvePresetTheme} so `CodeBlock` can
   *   be constructed directly with a preset name without going through
   *   `Markdown`.
   */
  constructor(
    code: string,
    lang: string,
    maxWidth: number,
    theme: MarkdownThemePresetName | MarkdownTheme,
    selectable = true,
  ) {
    super();
    const resolved = resolvePresetTheme(theme);
    this.source = code;
    this.lang = lang;
    this.theme = resolved;
    this.lineH = resolved.codeLineHeight;
    this.pad = resolved.codePadding;
    this.codeFont = `${resolved.codeFontSize}px ${resolved.codeFont}`;
    this.selectable = selectable;

    this.lines = [];
    this.width = maxWidth;
    this.buildLines(code);
  }

  /** Re-parse code content (e.g. for live editing). */
  setCode(code: string, lang?: string): this {
    if (lang !== undefined) this.lang = lang;
    this.source = code;
    this.buildLines(code);
    this.scene?.markDirty();
    return this;
  }

  /** Enable or disable browser-native selection for this code block. */
  public setSelectable(selectable: boolean): this {
    this.selectable = selectable;
    // Projected as `selectable`, and does not rebuild the lines.
    this.contentEpoch++;
    this.scene?.markDirty();
    return this;
  }

  public override getContentEpoch(): number {
    return this.contentEpoch;
  }

  /**
   * Change the block's box width.
   *
   * Deliberately does **not** rebuild the grid or the highlight, because code does
   * not reflow: lines are placed on a fixed monospace grid at `col × cellWidth` and
   * a long line overflows rather than wrapping, so `height` is a function of line
   * *count* alone. The width only sizes the rounded background. Anything that would
   * change the glyph geometry — the source, the language, the font — goes through
   * {@link setCode} and invalidates the grid there.
   *
   * @returns `this` for chaining.
   */
  public setWidth(width: number): this {
    const next = Math.max(0, width);
    if (next === this.width) return this;
    this.width = next;
    this.scene?.markDirty();
    return this;
  }

  public override getContentProjection(hint?: ContentProjectionHint): ContentProjection | null {
    if (!this.source) return null;
    const grid = this.ensureGrid();
    // Slicing the source per row is O(document) per synced frame, and the grid
    // path is also where the DOM cost concentrates (one carrier per glyph
    // CLUSTER). Building only the rows in the band is what makes a long code
    // block cost the viewport rather than the file.
    //
    // SPARSE, and index-aligned with `grid.lines`. Scene's grid path reads
    // `projection.lines[lineIndex]` by DOCUMENT row (`Scene.ts:4797`), so a
    // compacted array would hand row 900's geometry to row 0 and every carrier
    // would be positioned wrong. Holes simply fall back to the grid's own
    // uniform metrics there, which is exactly what a row outside the band needs.
    const rows: NonNullable<ContentProjection['lines']> = [];
    rows.length = grid.lines.length;
    for (let row = 0; row < grid.lines.length; row++) {
      const line = grid.lines[row];
      const y = this.pad + row * this.lineH;
      if (!contentLineInHint(hint, y, this.lineH)) continue;
      rows[row] = {
        text: this.source.slice(line.sourceStart, line.sourceEnd),
        separatorAfter: this.source.slice(line.sourceEnd, line.nextSourceStart) || undefined,
        x: this.pad,
        y,
        baseline: this.lineH * 0.75,
        font: this.codeFont,
        lineHeight: this.lineH,
      };
    }
    return {
      text: this.source,
      font: this.codeFont,
      lineHeight: this.lineH,
      // Every row is absolutely positioned from the same local coordinates as
      // render(). A single pre-wrap DOM text node would introduce browser
      // wrapping for long source lines that canvas intentionally keeps intact.
      //
      lines: rows,
      selectable: this.selectable,
      // render() draws cell-by-cell (no ligatures can form); the DOM copy
      // must not ligate either or Firefox selection geometry drifts.
      ligatures: 'none',
      grid,
    };
  }

  /**
   * Re-highlight the code, reusing the highlight of any unchanged line prefix.
   *
   * Streaming appends to the END of a block, so all but the last line or two are
   * byte-identical to the previous call — yet this used to re-highlight every
   * line on every chunk, making a streamed block O(N) per append and O(N^2)
   * overall. Reusing the stable prefix makes an append proportional to what
   * actually changed.
   *
   * The last previously-seen line is deliberately NOT reused: a chunk usually
   * lands mid-line, so that line's text (and therefore its tokenization) changes.
   */
  private buildLines(code: string): void {
    // The projection reports `source` and the grid built from it; `setCode` is
    // the only path that changes either, and it ends here.
    this.contentEpoch++;
    const rawLines = code.split(/\r\n|\r|\n/);
    const previous = this.rawLines;
    // Longest identical prefix, excluding the previous last line (see above).
    let reusable = 0;
    if (previous && this.lines.length === previous.length) {
      const limit = Math.min(previous.length - 1, rawLines.length);
      while (reusable < limit && previous[reusable] === rawLines[reusable]) reusable++;
    }

    if (reusable > 0) {
      const next = this.lines.slice(0, reusable);
      for (let i = reusable; i < rawLines.length; i++) {
        next.push(highlightLine(rawLines[i]!, this.lang, this.theme));
      }
      this.lines = next;
    } else {
      this.lines = rawLines.map((l) => highlightLine(l, this.lang, this.theme));
    }

    this.rawLines = rawLines;
    this.grid = null;
    this.height = this.pad * 2 + rawLines.length * this.lineH;
  }

  private ensureGrid(): PreparedContentGrid {
    const cellWidth = this.cellWidth || Math.max(1, measureText('M', this.codeFont));
    if (
      !this.grid ||
      this.grid.source !== this.source ||
      this.grid.font !== this.codeFont ||
      this.grid.cellWidth !== cellWidth
    ) {
      this.grid = prepareContentGrid(this.source, {
        font: this.codeFont,
        cellWidth,
        lineHeight: this.lineH,
        baseline: this.lineH * 0.75,
      });
    }
    return this.grid;
  }

  /** Code blocks are decorative — not interactive. */
  isPointInside(): boolean {
    return false;
  }

  render(r: IRenderer): void {
    // Background
    r.beginPath();
    r.roundRect(0, 0, this.width, this.height, this.theme.codeRadius);
    r.fill(this.theme.codeBgColor);

    const grid = this.ensureGrid();

    // Per-cluster grid drawing: every grapheme cluster is its own fillText at
    // col × cellWidth. Positioning whole segments on the grid is not enough —
    // Firefox applies OpenType ligatures on Canvas2D (Chrome doesn't), so a
    // run like "ffi affinity" ligates internally, compresses, and leaves a
    // gap before the next segment. Ligatures cannot form across separate
    // fillText calls, which makes the drawn grid identical in every browser
    // (canvas textRendering:'optimizeSpeed' would be cheaper, but Firefox —
    // the one engine that needs it — doesn't implement it). Wide CJK/emoji
    // clusters advance two cells, terminal wcwidth-style, so following
    // tokens no longer overlap them.
    // Where the renderer can blit a source rect, draw each cluster from a shared
    // glyph atlas instead. Identical call count and geometry, but ~2x cheaper per
    // call on both engines because the source texture never changes. A
    // per-run-canvas cache was measured *slower* than fillText on Chrome at scale
    // (0.87x at 40k cells) for exactly that reason — see
    // `forge/baselines/raster-cache-findings.md`.
    const atlas = codeGlyphAtlas(r);
    const atlasSource = atlas?.source ?? null;
    const blit = atlas ? r.drawImageRect : undefined;

    for (let row = 0; row < grid.lines.length; row++) {
      const yBaseline = this.pad + row * this.lineH + this.lineH * 0.75;
      const segments = this.lines[row];
      let segmentIndex = 0;
      let segmentEnd = segments[0]?.text.length ?? 0;
      const lineStart = grid.lines[row].sourceStart;
      for (const cell of grid.lines[row].cells) {
        const localSourceStart = cell.sourceStart - lineStart;
        while (segmentIndex < segments.length - 1 && localSourceStart >= segmentEnd) {
          segmentIndex++;
          segmentEnd += segments[segmentIndex].text.length;
        }
        const sourceText = this.source.slice(cell.sourceStart, cell.sourceEnd);
        if (cell.advance <= 0 || sourceText === ' ' || sourceText === '\t') continue;
        const color = segments[segmentIndex]?.color ?? this.theme.codeColor;
        const x = this.pad + cell.x;

        if (blit && atlas) {
          const slot = atlas.get(this.codeFont, color, cell.glyph);
          // `atlas.source` is null until the first successful rasterization, so
          // it is read per cell rather than hoisted — the first cell of the first
          // frame is what creates it.
          const src = atlasSource ?? atlas.source;
          if (slot && src) {
            // Destination offsets mirror the fillText baseline convention, so the
            // blit lands exactly where the glyph would have been drawn.
            blit.call(
              r,
              src,
              slot.sx,
              slot.sy,
              slot.sw,
              slot.sh,
              x - slot.offsetX,
              yBaseline - slot.offsetY,
              slot.w,
              slot.h,
            );
            continue;
          }
          // Anything the atlas declined (a cluster too large to pack, a headless
          // context) falls through to fillText below.
        }
        r.fillText(cell.glyph, x, yBaseline, this.codeFont, color);
      }
    }
  }
}

/**
 * Process-wide code-block glyph atlases, **keyed by device-pixel-ratio**.
 *
 * Shared rather than per-`CodeBlock` so a document's glyph set is rasterized once:
 * streamed markdown creates many code blocks over the same font and theme, and a
 * per-instance atlas would re-rasterize for each, discarding the reuse the whole
 * approach depends on. Slots carry `(font, colour, glyph)`, so multiple themes or
 * font sizes coexist correctly and merely occupy more slots.
 *
 * ## Why a pool and not one atlas
 *
 * A slot's `sx/sy/sw/sh` are device pixels at the ratio it was rasterized at, so
 * an atlas's DPR is immutable — and this used to be a single atlas capturing
 * `devicePixelRatio` at first use, with no rebuild path. A browser zoom therefore
 * left the code grid blitting stale pixels that the DPR-scaled context resampled,
 * while every other text entity re-rasterized: measured in Firefox 153 on one live
 * page, zooming 100% → 133% moved the renderer to 2.068 while the atlas stayed at
 * 1.579, and peak edge contrast inside the code block fell 171 → 139 → 73 across
 * 100/133/500% while prose held 255. **Only code looked soft**, which is exactly
 * why it read as a font bug rather than a cache bug.
 *
 * Keying on the ratio fixes that without mutation: a zoom simply selects a
 * different atlas, and zooming back reuses the first one rather than re-rasterizing
 * from scratch. It also makes two scenes at *different* effective ratios correct —
 * `SceneOptions.maxDPR` lets one scene cap at 2 while another runs uncapped, and a
 * single atlas would have thrashed between them every frame.
 *
 * Bounded to {@link MAX_CODE_ATLASES} entries, LRU-evicted and `destroy()`ed on
 * eviction, because each atlas holds a `maxSize²` canvas (2048² ≈ 16 MB) and a
 * pinch-zoom can walk through many ratios.
 *
 * The DPR comes from {@link IRenderer.pixelRatio} rather than
 * `window.devicePixelRatio`, so a clamped backing store gets an atlas matching
 * *it* — rasterizing at the window's ratio while the context is scaled to a
 * clamped one is the same resampling defect in a different disguise.
 *
 * Returns `undefined` when the renderer cannot blit a sub-rect (`SVGRenderer`, or
 * any renderer omitting the optional method), leaving the caller on `fillText` —
 * which is also the correct output for a vector export.
 */
const codeAtlases = new Map<number, GlyphRasterAtlas>();
/** LRU bound on {@link codeAtlases}. Two covers a zoom and its origin. */
const MAX_CODE_ATLASES = 2;
/** The atlas most recently handed out, for {@link codeAtlas}/{@link codeAtlasStats}. */
let lastCodeAtlas: GlyphRasterAtlas | null = null;

function codeGlyphAtlas(r: IRenderer): GlyphRasterAtlas | undefined {
  if (typeof r.drawImageRect !== 'function') return undefined;
  if (typeof document === 'undefined') return undefined;
  // Prefer the renderer's own backing-store ratio; fall back to the window only
  // for a backend that does not report one.
  const dpr = Math.max(
    1,
    r.pixelRatio ?? (typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1),
  );
  const existing = codeAtlases.get(dpr);
  if (existing) {
    // Refresh LRU position: re-insertion moves the key to the end of the
    // Map's iteration order, which is what makes the eviction below pick the
    // genuinely least-recently-used entry.
    codeAtlases.delete(dpr);
    codeAtlases.set(dpr, existing);
    lastCodeAtlas = existing;
    return existing;
  }
  // No `Math.min(dpr, 3)` cap here, deliberately. The cap was there because atlas
  // area grows with dpr², but it made *correctness impossible* on a display whose
  // real ratio exceeds it — this host's 500% zoom is 4.286, so a capped atlas is
  // permanently resampled by 1.43x and no amount of rebuilding helps. A code
  // block's glyph set is bounded (one mono font, one size, a handful of theme
  // colours), so the honest failure mode of an over-full atlas is `stats.resets`
  // climbing, which is already instrumented and already documented as the signal
  // to fall back to `fillText`.
  const atlas = new GlyphRasterAtlas({ dpr, maxSize: 2048 });
  codeAtlases.set(dpr, atlas);
  if (codeAtlases.size > MAX_CODE_ATLASES) {
    const oldestKey = codeAtlases.keys().next().value as number;
    const oldest = codeAtlases.get(oldestKey);
    codeAtlases.delete(oldestKey);
    // Release the backing canvas rather than waiting for GC: these are ~16 MB
    // each and an evicted atlas is unreachable anyway.
    if (oldest && oldest !== atlas) oldest.destroy();
  }
  lastCodeAtlas = atlas;
  return atlas;
}

/**
 * Instrumentation for the code-block glyph atlas in use, or `null` before first
 * use.
 *
 * Exposed so an app or benchmark can confirm the atlas is actually active and
 * reusing slots. Watch `resets`: a steadily climbing count means the glyph set is
 * unbounded for the atlas size, so every reset re-rasterizes everything and the
 * atlas is doing net harm rather than saving work.
 *
 * Reports the *most recently used* atlas, which after a zoom is the one now being
 * blitted — see {@link codeAtlas}.
 */
export function codeAtlasStats(): GlyphRasterAtlasStats | null {
  return lastCodeAtlas ? lastCodeAtlas.stats : null;
}

/**
 * The code-block atlas most recently blitted from, or `null` before first use.
 *
 * For instrumentation that must map a traced `drawImage` back to the glyph it
 * painted — a blit carries only a source rect, so `slotAt()` is the only way to
 * recover the cluster and its metrics. Used by `e2e/text-projection.e2e.ts` to
 * keep the code-grid positioning assertions working on the blit path.
 *
 * "Most recently used" rather than "the one" because atlases are pooled per DPR:
 * a caller resolving a traced blit wants the atlas that produced it, which is the
 * one the last render selected. Compare its {@link GlyphRasterAtlas.pixelRatio}
 * against {@link IRenderer.pixelRatio} to assert the blit is 1:1.
 */
export function codeAtlas(): GlyphRasterAtlas | null {
  return lastCodeAtlas;
}
