// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { CodeBlock, Markdown } from '../src/Markdown';
import { Image } from '@vectojs/ui';

/**
 * `renderMathToSVGDataURI` base64s the SVG with `btoa` on every REAL conversion
 * and not at all on a cache hit, so spying on it counts MathJax invocations
 * without exporting internals. `mathCache` is module-level and deliberately
 * shared across instances, so every test that counts conversions must use a
 * formula unique to itself — otherwise an earlier test's entry makes it pass for
 * the wrong reason.
 */
function countConversions(): { calls: () => number; restore: () => void } {
  const spy = vi.spyOn(globalThis, 'btoa');
  return {
    calls: () => spy.mock.calls.length,
    restore: () => spy.mockRestore(),
  };
}

const firstChild = (md: Markdown) => md.content.children[0] as any;
const mathImageOf = (md: Markdown): Image | null => {
  const container = firstChild(md);
  const inner = container?.children?.[0];
  return inner instanceof Image ? inner : null;
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('streaming math: conversion is deferred until the fence closes', () => {
  it('renders an unclosed math fence as a CodeBlock showing the TeX source', () => {
    const md = new Markdown('```math\n\\int_0^1 x');
    const child = firstChild(md);
    expect(child).toBeInstanceOf(CodeBlock);
    expect(child.source).toBe('\\int_0^1 x');
    expect(mathImageOf(md)).toBeNull();
  });

  it('typesets a closed math fence as an Image carrying the TeX as alt text', () => {
    const md = new Markdown('```math\n\\alpha + \\beta\n```');
    expect(firstChild(md)).not.toBeInstanceOf(CodeBlock);
    const img = mathImageOf(md);
    expect(img).not.toBeNull();
    expect(img!.alt).toBe('\\alpha + \\beta');
    expect(img!.src.startsWith('data:image/svg+xml;base64,')).toBe(true);
  });

  it('does not invoke MathJax while the fence is still open', () => {
    const counter = countConversions();
    const md = new Markdown('```math');
    md.appendMarkdown('\n\\gamma^{open}');
    md.appendMarkdown(' + \\delta');
    expect(counter.calls()).toBe(0);
    expect(firstChild(md)).toBeInstanceOf(CodeBlock);
    counter.restore();
  });

  it('converts exactly once across a formula streamed one chunk at a time', () => {
    const counter = countConversions();
    const md = new Markdown('```math');
    for (const chunk of ['\n', '\\zeta_{once}', ' = 1', ' + 2', '\n', '```', '\n']) {
      md.appendMarkdown(chunk);
    }
    // One conversion total: at the chunk that closed the fence. Before this
    // change every chunk converted, each on an invalid TeX prefix.
    expect(counter.calls()).toBe(1);
    expect(mathImageOf(md)).not.toBeNull();
    counter.restore();
  });

  it('keeps the same CodeBlock entity while the fence grows, then replaces it once', () => {
    const md = new Markdown('```math\n\\eta');
    const openEntity = firstChild(md);
    md.appendMarkdown('_1');
    expect(firstChild(md)).toBe(openEntity); // in-place setCode, no rebuild
    md.appendMarkdown(' + \\theta');
    expect(firstChild(md)).toBe(openEntity);
    md.appendMarkdown('\n```');
    // The closing fence must break reuse: a CodeBlock cannot become an Image.
    expect(firstChild(md)).not.toBe(openEntity);
    expect(mathImageOf(md)).not.toBeNull();
  });

  it('reuses the rendered formula when the newline after the fence arrives', () => {
    const md = new Markdown('```math\n\\iota\n```');
    const rendered = firstChild(md);
    const before = (md as any).streamStats.entitiesRebuilt;
    md.appendMarkdown('\n');
    // `raw` grew so the prefix match stops short, but the formula is unchanged.
    // Rebuilding here would re-decode the SVG for no visible difference.
    expect(firstChild(md)).toBe(rendered);
    expect((md as any).streamStats.entitiesRebuilt).toBe(before);
  });
});

describe('streaming math: formula cache', () => {
  it('converts a repeated formula once', () => {
    const counter = countConversions();
    const formula = '\\kappa_{cached} = \\lambda';
    new Markdown(`\`\`\`math\n${formula}\n\`\`\``);
    const afterFirst = counter.calls();
    expect(afterFirst).toBe(1);
    new Markdown(`\`\`\`math\n${formula}\n\`\`\``);
    new Markdown(`\`\`\`latex\n${formula}\n\`\`\``);
    expect(counter.calls()).toBe(afterFirst);
    counter.restore();
  });

  it('produces a byte-identical data URI on a cache hit', () => {
    const formula = '\\mu_{identical}^2';
    const a = mathImageOf(new Markdown(`\`\`\`math\n${formula}\n\`\`\``));
    const b = mathImageOf(new Markdown(`\`\`\`math\n${formula}\n\`\`\``));
    expect(a).not.toBeNull();
    expect(b!.src).toBe(a!.src);
    expect(b!.width).toBe(a!.width);
    expect(b!.height).toBe(a!.height);
  });

  it('does not confuse two different formulas', () => {
    const one = mathImageOf(new Markdown('```math\n\\nu_{first}\n```'));
    const two = mathImageOf(new Markdown('```math\n\\nu_{second}\n```'));
    expect(one!.src).not.toBe(two!.src);
  });
});

describe('streaming math: fence closure detection', () => {
  const isMathImage = (src: string) => mathImageOf(new Markdown(src)) !== null;

  it('accepts every math language alias', () => {
    expect(isMathImage('```math\nx\n```')).toBe(true);
    expect(isMathImage('```latex\nx\n```')).toBe(true);
    expect(isMathImage('```tex\nx\n```')).toBe(true);
    expect(isMathImage('```TeX\nx\n```')).toBe(true);
  });

  it('accepts a tilde fence and a longer-than-three fence', () => {
    expect(isMathImage('~~~math\nx\n~~~')).toBe(true);
    expect(isMathImage('````math\nx\n````')).toBe(true);
  });

  it('requires the closing fence to use the opening fence character', () => {
    // A `~~~` line does not close a ``` fence, so this is still open.
    expect(isMathImage('```math\nx\n~~~')).toBe(false);
  });

  it('requires the closing fence to be at least as long as the opening', () => {
    expect(isMathImage('````math\nx\n```')).toBe(false);
  });

  it('treats an indented closing fence as closing', () => {
    expect(isMathImage('```math\nx\n  ```')).toBe(true);
  });

  it('leaves a non-math fence alone whether closed or not', () => {
    expect(isMathImage('```ts\nconst x = 1;\n```')).toBe(false);
    expect(firstChild(new Markdown('```ts\nconst x = 1;\n```'))).toBeInstanceOf(CodeBlock);
  });

  it('renders an empty closed math fence as a CodeBlock, not a zero-size image', () => {
    const md = new Markdown('```math\n```');
    expect(firstChild(md)).toBeInstanceOf(CodeBlock);
    expect(mathImageOf(md)).toBeNull();
  });
});

describe('streaming math inside a blockquote', () => {
  it('renders a closed nested formula as an Image', () => {
    const md = new Markdown('> intro\n>\n> ```math\n> \\rho_{quoted}\n> ```');
    const found: Image[] = [];
    const walk = (e: any) => {
      if (e instanceof Image) found.push(e);
      for (const c of e.children ?? []) walk(c);
    };
    walk(md.content);
    expect(found.length).toBe(1);
    expect(found[0].alt).toBe('\\rho_{quoted}');
  });

  it('refuses tail reuse when a nested fence closes, so the formula typesets', () => {
    const md = new Markdown('> ```math\n> \\sigma_{tail}');
    const openInner = (md.content.children[0] as any).children[1].children.at(-1).children[0];
    expect(openInner).toBeInstanceOf(CodeBlock);
    md.appendMarkdown('\n> ```');
    const found: Image[] = [];
    const walk = (e: any) => {
      if (e instanceof Image) found.push(e);
      for (const c of e.children ?? []) walk(c);
    };
    walk(md.content);
    expect(found.length).toBe(1);
    expect(found[0].alt).toBe('\\sigma_{tail}');
  });

  it('still reuses a nested non-math code fence in place', () => {
    const md = new Markdown('> ```ts\n> const a = 1;');
    const inner = (md.content.children[0] as any).children[1].children.at(-1).children[0];
    expect(inner).toBeInstanceOf(CodeBlock);
    md.appendMarkdown('\n> const b = 2;');
    const after = (md.content.children[0] as any).children[1].children.at(-1).children[0];
    expect(after).toBe(inner);
  });
});

describe('streaming math: async SVG decode repaints the scene', () => {
  it('marks the scene dirty when the formula bitmap loads', () => {
    const md = new Markdown('```math\n\\tau_{decode}\n```');
    const markDirty = vi.fn();
    // `Entity.scene` is a getter that walks up to the nearest `_scene`, so the
    // stub has to be installed on the private field the getter reads.
    (md as any)._scene = { markDirty };
    const img = mathImageOf(md);
    expect(img).not.toBeNull();
    // Simulate the browser finishing the data-URI decode.
    (img as any).bitmap?.onload?.();
    expect(markDirty).toHaveBeenCalled();
  });
});
