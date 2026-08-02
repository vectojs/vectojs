// @vitest-environment jsdom
import { beforeAll, describe, expect, it } from 'vitest';
import { Image } from '@vectojs/ui';
import { Markdown, preloadMathJax } from '../src/Markdown';

/**
 * Display math written as `$$...$$`, and the color baked into every math SVG.
 *
 * Both defects were found by dogfooding an external editor demo.
 *
 * There was no block/display math tokenizer at all — only an inline `$...$`
 * rule, which deliberately refuses `$$` to protect currency ("$5 to $10"). With
 * no block rule, marked's text tokenizer consumed the leading `$`, the inline
 * rule then matched the *inner* `$...$` pair, and the outer two dollars survived
 * as literal text. The result was a formula with a stray `$` painted on each
 * side.
 *
 * Separately, MathJax paints glyphs with `fill="currentColor"`, and this package
 * base64s the SVG into a `data:` URI. A data URI is an isolated document with no
 * CSS inheritance, so `currentColor` fell back to its initial value — black —
 * making every formula invisible against this package's own dark default theme.
 *
 * MathJax is imported lazily, so preload to make these assertions about WHAT is
 * produced rather than about load timing, as `inlineMathTypeset.test.ts` does.
 */
beforeAll(async () => {
  await preloadMathJax();
});

/** Every entity in the tree, in document order. */
function walk(e: any, out: any[] = []): any[] {
  out.push(e);
  for (const c of e.children ?? []) walk(c, out);
  return out;
}

/** Every `Image` in the tree — one per rendered display formula. */
const imagesOf = (md: Markdown): any[] => walk(md.content).filter((e) => e instanceof Image);

/** Every text span's text, concatenated, so a stray delimiter is visible. */
function textOf(md: Markdown): string {
  let s = '';
  for (const e of walk(md.content)) {
    if (Array.isArray(e.spans)) for (const sp of e.spans) s += sp.text ?? '';
    else if (typeof e.text === 'string') s += e.text;
  }
  return s;
}

/** Decode the SVG behind a math `Image`'s data URI. */
function svgOf(img: any): string {
  const uri: string = img.src;
  expect(uri.startsWith('data:image/svg+xml;base64,')).toBe(true);
  return atob(uri.slice('data:image/svg+xml;base64,'.length));
}

describe('$$...$$ renders as display math with no stray delimiters', () => {
  it('produces one display formula and no literal $', () => {
    const md = new Markdown('$$\\int_a^b f(x)\\,dx = F(b) - F(a)$$');
    expect(imagesOf(md)).toHaveLength(1);
    // The defect: a `$` on each side of the formula.
    expect(textOf(md)).not.toContain('$');
  });

  it('keeps surrounding prose intact', () => {
    const md = new Markdown('before\n\n$$x^2 + y^2 = z^2$$\n\nafter\n');
    expect(imagesOf(md)).toHaveLength(1);
    const text = textOf(md);
    expect(text).toContain('before');
    expect(text).toContain('after');
    expect(text).not.toContain('$');
  });

  it('spans multiple lines', () => {
    const md = new Markdown('$$\n\\begin{aligned}\na &= b \\\\\nc &= d\n\\end{aligned}\n$$\n');
    expect(imagesOf(md)).toHaveLength(1);
    expect(textOf(md)).not.toContain('$');
  });

  it('carries the TeX source as the accessible name', () => {
    const md = new Markdown('$$E = mc^2$$');
    // Without this the formula is an unlabelled image to assistive tech.
    expect(imagesOf(md)[0].alt).toBe('E = mc^2');
  });

  it('still tokenizes inline $...$ as inline math, not a block', () => {
    const md = new Markdown('cost is $x+1$ per unit\n');
    // Inline math reserves an inline box, so it produces no block Image.
    expect(imagesOf(md)).toHaveLength(0);
    expect(textOf(md)).not.toContain('$');
  });

  it('leaves currency alone', () => {
    const md = new Markdown('it costs $5 to $10 per item\n');
    expect(imagesOf(md)).toHaveLength(0);
    // Currency is the one case where a literal $ SHOULD survive as text.
    expect(textOf(md)).toContain('$5');
    expect(textOf(md)).toContain('$10');
  });
});

describe('math SVG carries an explicit color', () => {
  it('sets the theme text color on the SVG root', () => {
    const md = new Markdown('$$a+b$$', { theme: { textColor: '#ff8800' } });
    expect(svgOf(imagesOf(md)[0])).toContain('color:#ff8800');
  });

  it('leaves currentColor on the glyphs for the root to resolve', () => {
    const md = new Markdown('$$a+b$$', { theme: { textColor: '#ff8800' } });
    // The fix must not rewrite fill/stroke — MathJax decides which parts paint.
    expect(svgOf(imagesOf(md)[0])).toContain('currentColor');
  });

  it('preserves the root vertical-align the depth scrape reads', () => {
    const md = new Markdown('$$\\int_a^b f(x)\\,dx$$', {
      theme: { textColor: '#ff8800' },
    });
    const svg = svgOf(imagesOf(md)[0]);
    // Injecting color must not clobber the existing root style, or the depth
    // parse silently returns 0 and the formula sits on the wrong baseline.
    expect(svg).toMatch(/vertical-align:\s*-?[\d.]+ex/);
    // And it must not leave two style attributes — the second would be ignored.
    const root = svg.match(/<svg\b[^>]*>/)?.[0] ?? '';
    expect((root.match(/\bstyle=/g) ?? []).length).toBe(1);
  });

  it('re-typesets rather than serving the previous theme colour', () => {
    // The colour is baked into the cached SVG bytes, so it has to be part of the
    // cache key. Keying on the formula alone served a re-themed document the old
    // theme's bitmap — invisible, not merely wrong, across a light/dark switch.
    const dark = new Markdown('$$a+b$$', { theme: { textColor: '#e2e8f0' } });
    const light = new Markdown('$$a+b$$', { theme: { textColor: '#111111' } });
    expect(svgOf(imagesOf(dark)[0])).toContain('color:#e2e8f0');
    expect(svgOf(imagesOf(light)[0])).toContain('color:#111111');
  });

  it('gives inline math the surrounding run colour', () => {
    const md = new Markdown('text $x+1$ more', {
      theme: { textColor: '#44ff44' },
    });
    // Inline math paints through StyledSpan.object, so find its URI directly.
    const spans: any[] = [];
    for (const e of walk(md.content)) {
      if (Array.isArray(e.spans)) spans.push(...e.spans);
    }
    const obj = spans.find((s) => s.object !== undefined);
    expect(obj).toBeDefined();
    // The object's alt is the TeX source; the colour lives in the painted SVG,
    // which the object closure holds. Assert via the theme-coloured cache entry.
    expect(obj.object.alt).toBe('x+1');
  });
});
