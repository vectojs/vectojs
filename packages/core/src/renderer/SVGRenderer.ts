import { IRenderer } from './IRenderer';
import { sanitizeUrl } from './url';

export interface SVGLinearGradient {
  type: 'linear';
  id?: string;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  colorStops: { stop: number; color: string }[];
  createMatrix: number[];
}

function parseFontSizeToken(
  font: string,
): { value: number; unit: 'px' | 'em' | 'rem'; start: number; end: number } | null {
  for (let i = 0; i < font.length; i++) {
    const ch = font[i];
    if (!((ch >= '0' && ch <= '9') || ch === '.')) continue;

    let j = i + 1;
    while (j < font.length) {
      const next = font[j];
      if ((next >= '0' && next <= '9') || next === '.') {
        j++;
      } else {
        break;
      }
    }

    const unit = font.startsWith('rem', j)
      ? 'rem'
      : font.startsWith('em', j)
        ? 'em'
        : font.startsWith('px', j)
          ? 'px'
          : null;
    if (!unit) {
      i = j;
      continue;
    }

    let end = j + unit.length;
    if (font[end] === '/') {
      end++;
      while (end < font.length && font[end] !== ' ' && font[end] !== '\t') end++;
    }

    const value = Number.parseFloat(font.slice(i, j));
    return Number.isFinite(value) ? { value, unit, start: i, end } : null;
  }

  return null;
}

function fontFamilyFromShorthand(font: string, sizeToken: { start: number; end: number } | null) {
  const withoutSize = sizeToken
    ? `${font.slice(0, sizeToken.start)} ${font.slice(sizeToken.end)}`.trim()
    : font.trim();
  const family = withoutSize
    .split(' ')
    .map((part) => part.trim())
    .filter(
      (part) =>
        part &&
        ![
          'bold',
          'italic',
          'oblique',
          'normal',
          '900',
          '800',
          '700',
          '600',
          '500',
          '400',
          '300',
          '200',
          '100',
        ].includes(part.toLowerCase()),
    )
    .join(' ');
  return family || 'sans-serif';
}

export class SVGRenderer implements IRenderer {
  private width: number;
  private height: number;
  private buffer: string[] = [];
  private defsBuffer: string[] = [];
  private currentPath: string[] = [];

  // Inline matrix states (3x3 representation)
  // [a, b, c, d, e, f] corresponding to:
  // | a c e |
  // | b d f |
  // | 0 0 1 |
  private mStack: number[][] = [];
  private ma = 1;
  private mb = 0;
  private mc = 0;
  private md = 1;
  private me = 0;
  private mf = 0;

  // Alpha stack
  private alphaStack: number[] = [];
  private globalAlpha = 1;

  // Clipping stack
  private clipDepthStack: number[] = [];
  private clipDepth = 0;
  private clipCounter = 0; // uniquely identifies clipPaths

  // Batch circles states (local coordinates)
  private batchCircles: { cx: number; cy: number; r: number }[] = [];
  private batchMatrix: number[] = [1, 0, 0, 1, 0, 0];
  private batchColor = '';
  private batchAlpha = 1;
  private batchActive = false;

  // Cache for generated gradient defs
  private gradientCounter = 0;
  private gradientCache: Map<string, string> = new Map();

  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
  }

  public clear(): void {
    this.buffer = [];
    this.defsBuffer = [];
    this.currentPath = [];
    this.gradientCounter = 0;
    this.clipCounter = 0;
    this.gradientCache.clear();
    this.mStack = [];
    this.alphaStack = [];
    this.clipDepthStack = [];
    this.ma = 1;
    this.mb = 0;
    this.mc = 0;
    this.md = 1;
    this.me = 0;
    this.mf = 0;
    this.globalAlpha = 1;
    this.clipDepth = 0;
    this.batchCircles = [];
    this.batchActive = false;
  }

  public save(): void {
    this.flush();
    this.mStack.push([this.ma, this.mb, this.mc, this.md, this.me, this.mf]);
    this.alphaStack.push(this.globalAlpha);
    this.clipDepthStack.push(this.clipDepth);
  }

  public restore(): void {
    this.flush();
    if (this.mStack.length > 0) {
      const m = this.mStack.pop()!;
      this.ma = m[0];
      this.mb = m[1];
      this.mc = m[2];
      this.md = m[3];
      this.me = m[4];
      this.mf = m[5];
    }
    if (this.alphaStack.length > 0) {
      this.globalAlpha = this.alphaStack.pop()!;
    }
    if (this.clipDepthStack.length > 0) {
      const poppedClipDepth = this.clipDepthStack.pop()!;
      if (poppedClipDepth < this.clipDepth) {
        for (let i = 0; i < this.clipDepth - poppedClipDepth; i++) {
          this.buffer.push('</g>');
        }
        this.clipDepth = poppedClipDepth;
      }
    }
  }

  public translate(dx: number, dy: number): void {
    this.me = this.ma * dx + this.mc * dy + this.me;
    this.mf = this.mb * dx + this.md * dy + this.mf;
  }

  public scale(sx: number, sy: number): void {
    this.ma *= sx;
    this.mb *= sx;
    this.mc *= sy;
    this.md *= sy;
  }

  public rotate(angle: number): void {
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const a0 = this.ma,
      b0 = this.mb,
      c0 = this.mc,
      d0 = this.md;
    this.ma = a0 * cos + c0 * sin;
    this.mb = b0 * cos + d0 * sin;
    this.mc = -a0 * sin + c0 * cos;
    this.md = -b0 * sin + d0 * cos;
  }

  public setGlobalAlpha(alpha: number): void {
    this.globalAlpha = alpha;
  }

  public beginPath(): void {
    this.currentPath = [];
  }

  public moveTo(x: number, y: number): void {
    this.currentPath.push(`M ${x} ${y}`);
  }

  public lineTo(x: number, y: number): void {
    this.currentPath.push(`L ${x} ${y}`);
  }

  public bezierCurveTo(
    cp1x: number,
    cp1y: number,
    cp2x: number,
    cp2y: number,
    x: number,
    y: number,
  ): void {
    this.currentPath.push(`C ${cp1x} ${cp1y} ${cp2x} ${cp2y} ${x} ${y}`);
  }

  public closePath(): void {
    this.currentPath.push('Z');
  }

  public arc(
    x: number,
    y: number,
    r: number,
    startAngle: number,
    endAngle: number,
    ccw?: boolean,
  ): void {
    const xs = x + r * Math.cos(startAngle);
    const ys = y + r * Math.sin(startAngle);
    if (this.currentPath.length === 0) {
      this.currentPath.push(`M ${xs} ${ys}`);
    } else {
      this.currentPath.push(`L ${xs} ${ys}`);
    }

    // Canvas sweep semantics: the arc travels from startAngle to endAngle in
    // the requested direction. A full circle only happens when the signed
    // delta in that direction reaches 2π; everything else is normalized into
    // [0, 2π) — e.g. clockwise 0 → -π/2 travels 3π/2, not π/2.
    const TWO_PI = Math.PI * 2;
    const directedDelta = ccw ? startAngle - endAngle : endAngle - startAngle;
    const sweepAngle =
      directedDelta >= TWO_PI ? TWO_PI : ((directedDelta % TWO_PI) + TWO_PI) % TWO_PI;
    const sweep = ccw ? 0 : 1;

    if (sweepAngle >= TWO_PI - 0.0001) {
      const xm = x - r * Math.cos(startAngle);
      const ym = y - r * Math.sin(startAngle);
      this.currentPath.push(`A ${r} ${r} 0 0 ${sweep} ${xm} ${ym}`);
      this.currentPath.push(`A ${r} ${r} 0 0 ${sweep} ${xs} ${ys}`);
    } else {
      const xe = x + r * Math.cos(endAngle);
      const ye = y + r * Math.sin(endAngle);
      const largeArc = sweepAngle > Math.PI ? 1 : 0;
      this.currentPath.push(`A ${r} ${r} 0 ${largeArc} ${sweep} ${xe} ${ye}`);
    }
  }

  public roundRect(x: number, y: number, w: number, h: number, radii: number | number[]): void {
    if (w < 0) {
      x += w;
      w = -w;
    }
    if (h < 0) {
      y += h;
      h = -h;
    }

    let r_tl = 0,
      r_tr = 0,
      r_br = 0,
      r_bl = 0;
    if (typeof radii === 'number') {
      r_tl = r_tr = r_br = r_bl = radii;
    } else if (Array.isArray(radii)) {
      if (radii.length === 1) {
        r_tl = r_tr = r_br = r_bl = radii[0];
      } else if (radii.length === 2) {
        r_tl = r_br = radii[0];
        r_tr = r_bl = radii[1];
      } else if (radii.length === 3) {
        r_tl = radii[0];
        r_tr = r_bl = radii[1];
        r_br = radii[2];
      } else if (radii.length >= 4) {
        r_tl = radii[0];
        r_tr = radii[1];
        r_br = radii[2];
        r_bl = radii[3];
      }
    }

    const tl_tr = r_tl + r_tr;
    const bl_br = r_bl + r_br;
    const tl_bl = r_tl + r_bl;
    const tr_br = r_tr + r_br;
    let factor = 1.0;
    if (tl_tr > w) factor = Math.min(factor, w / tl_tr);
    if (bl_br > w) factor = Math.min(factor, w / bl_br);
    if (tl_bl > h) factor = Math.min(factor, h / tl_bl);
    if (tr_br > h) factor = Math.min(factor, h / tr_br);
    if (factor < 1.0) {
      r_tl *= factor;
      r_tr *= factor;
      r_br *= factor;
      r_bl *= factor;
    }

    this.currentPath.push(`M ${x + r_tl} ${y}`);
    this.currentPath.push(`L ${x + w - r_tr} ${y}`);
    this.currentPath.push(`A ${r_tr} ${r_tr} 0 0 1 ${x + w} ${y + r_tr}`);
    this.currentPath.push(`L ${x + w} ${y + h - r_br}`);
    this.currentPath.push(`A ${r_br} ${r_br} 0 0 1 ${x + w - r_br} ${y + h}`);
    this.currentPath.push(`L ${x + r_bl} ${y + h}`);
    this.currentPath.push(`A ${r_bl} ${r_bl} 0 0 1 ${x} ${y + h - r_bl}`);
    this.currentPath.push(`L ${x} ${y + r_tl}`);
    this.currentPath.push(`A ${r_tl} ${r_tl} 0 0 1 ${x + r_tl} ${y}`);
    this.currentPath.push('Z');
  }

  public fill(colorOrGradient: string | SVGLinearGradient): void {
    this.flush();
    const fillVal = this.escapeXML(this.resolveGradient(colorOrGradient));
    const dStr = this.currentPath.join(' ');
    const transformStr = `matrix(${this.ma},${this.mb},${this.mc},${this.md},${this.me},${this.mf})`;
    this.buffer.push(
      `<path d="${dStr}" transform="${transformStr}" fill="${fillVal}" opacity="${this.globalAlpha}" />`,
    );
  }

  public stroke(colorOrGradient: string | SVGLinearGradient, lineWidth = 1): void {
    this.flush();
    const strokeVal = this.escapeXML(this.resolveGradient(colorOrGradient));
    const dStr = this.currentPath.join(' ');
    const transformStr = `matrix(${this.ma},${this.mb},${this.mc},${this.md},${this.me},${this.mf})`;
    this.buffer.push(
      `<path d="${dStr}" transform="${transformStr}" fill="none" stroke="${strokeVal}" stroke-width="${lineWidth}" stroke-opacity="${this.globalAlpha}" />`,
    );
  }

  public fillText(
    text: string,
    x: number,
    y: number,
    font: string,
    color: string | SVGLinearGradient,
  ): void {
    this.flush();
    const sizeToken = parseFontSizeToken(font);
    let fontSize = sizeToken ? sizeToken.value : 16;
    if (sizeToken && sizeToken.unit !== 'px') {
      fontSize = fontSize * 16;
    }

    const lowerFont = font.toLowerCase();
    const fontStyle = lowerFont.includes('italic')
      ? 'italic'
      : lowerFont.includes('oblique')
        ? 'oblique'
        : 'normal';
    const fontWeight = lowerFont.includes('bold')
      ? 'bold'
      : (['900', '800', '700', '600', '500', '400', '300', '200', '100'].find((weight) =>
          lowerFont.includes(weight),
        ) ?? 'normal');
    const fontFamily = fontFamilyFromShorthand(font, sizeToken);

    const fillVal = this.escapeXML(this.resolveGradient(color));
    const transformStr = `matrix(${this.ma},${this.mb},${this.mc},${this.md},${this.me},${this.mf})`;
    this.buffer.push(
      `<g transform="${transformStr}"><text x="${x}" y="${y}" font-size="${fontSize}" font-weight="${fontWeight}" font-style="${fontStyle}" font-family="${this.escapeXML(fontFamily)}" fill="${fillVal}" opacity="${this.globalAlpha}">${this.escapeXML(text)}</text></g>`,
    );
  }

  public fillCircle(cx: number, cy: number, radius: number, color: string, alpha?: number): void {
    const targetAlpha = alpha ?? 1;
    const matrixEq =
      this.batchMatrix[0] === this.ma &&
      this.batchMatrix[1] === this.mb &&
      this.batchMatrix[2] === this.mc &&
      this.batchMatrix[3] === this.md &&
      this.batchMatrix[4] === this.me &&
      this.batchMatrix[5] === this.mf;

    if (
      this.batchActive &&
      (!matrixEq || this.batchColor !== color || this.batchAlpha !== targetAlpha)
    ) {
      this.flush();
    }

    if (!this.batchActive) {
      this.batchMatrix = [this.ma, this.mb, this.mc, this.md, this.me, this.mf];
      this.batchColor = color;
      this.batchAlpha = targetAlpha;
      this.batchActive = true;
    }

    this.batchCircles.push({ cx, cy, r: radius });
  }

  public drawImage(source: any, dx: number, dy: number, dw: number, dh: number): void {
    this.flush();
    const fromCanvas = typeof source?.toDataURL === 'function';
    const rawHref = fromCanvas ? source.toDataURL() : source?.src || '';
    const href =
      fromCanvas && this.isSafeRasterDataUrl(rawHref) ? rawHref : sanitizeUrl(String(rawHref));
    const transformStr = `matrix(${this.ma},${this.mb},${this.mc},${this.md},${this.me},${this.mf})`;
    if (href) {
      this.buffer.push(
        `<image href="${this.escapeXML(href)}" x="${dx}" y="${dy}" width="${dw}" height="${dh}" transform="${transformStr}" />`,
      );
    } else {
      this.buffer.push(
        `<rect x="${dx}" y="${dy}" width="${dw}" height="${dh}" transform="${transformStr}" fill="rgba(0,0,0,0.5)" />`,
      );
      console.warn('drawImage source fallback triggered');
    }
  }

  /**
   * Embed SVG markup as an isolated nested image.
   *
   * This explicit path is used by `SVGEntity` during vector export. General
   * `drawImage()` input remains subject to the URL policy and therefore still
   * rejects caller-provided SVG data URLs.
   */
  public drawSVG(source: string, dx: number, dy: number, dw: number, dh: number): void {
    this.flush();
    const href = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(source)}`;
    const transformStr = `matrix(${this.ma},${this.mb},${this.mc},${this.md},${this.me},${this.mf})`;
    this.buffer.push(
      `<image href="${this.escapeXML(href)}" x="${dx}" y="${dy}" width="${dw}" height="${dh}" transform="${transformStr}" />`,
    );
  }

  public flush(): void {
    if (!this.batchActive || this.batchCircles.length === 0) return;
    let d = '';
    for (const c of this.batchCircles) {
      const cx_minus_r = c.cx - c.r;
      const cx_plus_r = c.cx + c.r;
      // render circle using two half-circle arcs
      d += `M ${cx_minus_r} ${c.cy} A ${c.r} ${c.r} 0 1 0 ${cx_plus_r} ${c.cy} A ${c.r} ${c.r} 0 1 0 ${cx_minus_r} ${c.cy} `;
    }
    const transformStr = `matrix(${this.batchMatrix.join(',')})`;
    const pathNode = `<path d="${d.trim()}" transform="${transformStr}" fill="${this.escapeXML(this.batchColor)}" opacity="${this.batchAlpha}" />`;
    this.buffer.push(pathNode);
    this.batchCircles = [];
    this.batchActive = false;
  }

  public createLinearGradient(
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    colorStops: { stop: number; color: string }[],
  ): SVGLinearGradient {
    return {
      type: 'linear',
      x0,
      y0,
      x1,
      y1,
      colorStops,
      createMatrix: [this.ma, this.mb, this.mc, this.md, this.me, this.mf],
    };
  }

  public clip(x: number, y: number, width: number, height: number): void {
    this.flush();
    const id = `clip-${this.clipCounter++}`;
    const transformStr = `matrix(${this.ma},${this.mb},${this.mc},${this.md},${this.me},${this.mf})`;
    const clipXML = `<clipPath id="${id}"><rect x="${x}" y="${y}" width="${width}" height="${height}" transform="${transformStr}" /></clipPath>`;
    this.defsBuffer.push(clipXML);
    this.buffer.push(`<g clip-path="url(#${id})">`);
    this.clipDepth++;
  }

  public toXMLString(): string {
    this.flush();
    let xml = `<svg width="${this.width}" height="${this.height}" viewBox="0 0 ${this.width} ${this.height}" xmlns="http://www.w3.org/2000/svg">`;
    if (this.defsBuffer.length > 0) {
      xml += `<defs>${this.defsBuffer.join('\n')}</defs>`;
    }
    xml += this.buffer.join('\n');
    for (let i = 0; i < this.clipDepth; i++) {
      xml += '</g>';
    }
    xml += '</svg>';
    return xml;
  }

  private resolveGradient(colorOrGradient: string | SVGLinearGradient): string {
    if (typeof colorOrGradient === 'string') {
      return colorOrGradient;
    }

    const gradient = colorOrGradient;
    const [c_a, c_b, c_c, c_d, c_e, c_f] = gradient.createMatrix;
    const Det = this.ma * this.md - this.mb * this.mc;

    let inv_a = 1,
      inv_b = 0,
      inv_c = 0,
      inv_d = 1,
      inv_e = 0,
      inv_f = 0;
    if (Math.abs(Det) > 1e-6) {
      inv_a = this.md / Det;
      inv_b = -this.mb / Det;
      inv_c = -this.mc / Det;
      inv_d = this.ma / Det;
      inv_e = (this.mc * this.mf - this.md * this.me) / Det;
      inv_f = (this.mb * this.me - this.ma * this.mf) / Det;
    }

    const g_a = inv_a * c_a + inv_c * c_b;
    const g_b = inv_b * c_a + inv_d * c_b;
    const g_c = inv_a * c_c + inv_c * c_d;
    const g_d = inv_b * c_c + inv_d * c_d;
    const g_e = inv_a * c_e + inv_c * c_f + inv_e;
    const g_f = inv_b * c_e + inv_d * c_f + inv_f;

    const stopsStr = JSON.stringify(gradient.colorStops);
    const x0_prime = c_a * gradient.x0 + c_c * gradient.y0 + c_e;
    const y0_prime = c_b * gradient.x0 + c_d * gradient.y0 + c_f;
    const x1_prime = c_a * gradient.x1 + c_c * gradient.y1 + c_e;
    const y1_prime = c_b * gradient.x1 + c_d * gradient.y1 + c_f;
    const key = `${x0_prime}_${y0_prime}_${x1_prime}_${y1_prime}_${stopsStr}_${this.ma}_${this.mb}_${this.mc}_${this.md}_${this.me}_${this.mf}`;

    let id = this.gradientCache.get(key);
    if (!id) {
      id = `vecto-linear-grad-${this.gradientCounter++}`;
      let stopsXML = '';
      for (const stop of gradient.colorStops) {
        stopsXML += `<stop offset="${stop.stop}" stop-color="${this.escapeXML(stop.color)}" />`;
      }
      const gradientTransform = `matrix(${g_a},${g_b},${g_c},${g_d},${g_e},${g_f})`;
      const gradXML = `<linearGradient id="${id}" x1="${gradient.x0}" y1="${gradient.y0}" x2="${gradient.x1}" y2="${gradient.y1}" gradientUnits="userSpaceOnUse" gradientTransform="${gradientTransform}">${stopsXML}</linearGradient>`;
      this.defsBuffer.push(gradXML);
      this.gradientCache.set(key, id);
    }

    return `url(#${id})`;
  }

  private escapeXML(str: string): string {
    return str.replace(/[<>&'"]/g, (c) => {
      switch (c) {
        case '<':
          return '&lt;';
        case '>':
          return '&gt;';
        case '&':
          return '&amp;';
        case "'":
          return '&apos;';
        case '"':
          return '&quot;';
        default:
          return c;
      }
    });
  }

  private isSafeRasterDataUrl(value: unknown): value is string {
    return (
      typeof value === 'string' &&
      /^data:image\/(?:png|jpeg|gif|webp);base64,[a-z\d+/=\s]*$/i.test(value)
    );
  }

  /**
   * SVGRenderer accumulates strings in memory; nothing external is allocated.
   * Drop the buffers for GC and become idempotent.
   */
  public dispose(): void {
    this.clear();
    this.gradientCache.clear();
  }
}
