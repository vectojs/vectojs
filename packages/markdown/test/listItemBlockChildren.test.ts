// @vitest-environment jsdom
import { beforeAll, describe, expect, it } from 'vitest';
import { CodeBlock, Markdown, preloadMathJax } from '../src/Markdown';
import { Image, Table } from '@vectojs/ui';

/**
 * Block-level children of a list item.
 *
 * A list item is not an inline run. CommonMark lets it hold any block —
 * a display formula, a fenced code block, a table, a nested list — and a real
 * document does so constantly:
 *
 *     1. **Numerical solver**: the engine integrates per frame.
 *        $$v_{t+\Delta t} = v_t + a \cdot \Delta t$$
 *
 * The renderer built each item as ONE `RichText` from `listItemSpans()`, an
 * inline-only path with no branch for a block child. marked DOES emit a
 * `blockMath` token as a sibling of the item's inline `text` (verified — parsing
 * was never the problem), so the block's raw TeX fell through `listItemSpans`'
 * `'text' in inner` fallback and was painted as literal characters.
 *
 * Measured on a real 60-line document: line 56's formula at indent 0 rendered,
 * while all nine `$$…$$` at indent 2 inside list items did not — 9 of its 10
 * display formulas. The discriminator is list membership, not the formula.
 *
 * The fast path matters and is kept: a list item whose children are all inline
 * must still build exactly one `RichText`, because `updateStreamedList` reuses
 * that entity per chunk via `setSpans` and a Stack-per-item would forfeit it.
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

/** Every text span's text in the subtree, concatenated. */
function textOf(root: any): string {
  let s = '';
  for (const e of walk(root)) {
    if (Array.isArray(e.spans)) for (const sp of e.spans) s += sp.text ?? '';
    else if (typeof e.text === 'string') s += e.text;
  }
  return s;
}

const imagesOf = (root: any): any[] => walk(root).filter((e) => e instanceof Image);

describe('a list item renders its block-level children', () => {
  it('typesets $$…$$ inside a list item instead of painting raw TeX', () => {
    const md = new Markdown(
      ['1. **Solver**: integrates per frame.', '   $$v_{t} = v_0 + a t$$'].join('\n'),
      { maxWidth: 600 },
    );

    // The formula becomes a math Image, exactly as it would at indent 0.
    expect(imagesOf(md.content).length).toBe(1);
    // And its source is NOT left lying around as literal characters.
    const text = textOf(md.content);
    expect(text).not.toContain('v_{t}');
    expect(text).not.toContain('$$');
    // The item's own inline content survives.
    expect(text).toContain('Solver');
    expect(text).toContain('integrates per frame.');
  });

  it('renders several formulas across several items', () => {
    // The real document's shape: every item carries its own display math.
    const md = new Markdown(
      [
        '1. First law.',
        '   $$a = F/m$$',
        '2. Second law.',
        '   $$E = mc^2$$',
        '3. Third law.',
        '   $$F_1 = -F_2$$',
      ].join('\n'),
      { maxWidth: 600 },
    );

    expect(imagesOf(md.content).length).toBe(3);
    const text = textOf(md.content);
    for (const tex of ['a = F/m', 'E = mc^2', 'F_1 = -F_2']) {
      expect(text).not.toContain(tex);
    }
  });

  it('renders a fenced code block inside a list item', () => {
    const md = new Markdown(
      ['1. Install it:', '', '   ```bash', '   bun add @vectojs/core', '   ```'].join('\n'),
      { maxWidth: 600 },
    );

    const codeBlocks = walk(md.content).filter((e) => e instanceof CodeBlock);
    expect(codeBlocks.length).toBe(1);
    // The fence markers must not survive as text.
    expect(textOf(md.content)).not.toContain('```');
  });

  it('renders a table inside a list item', () => {
    const md = new Markdown(
      ['1. The numbers:', '', '   | a | b |', '   | - | - |', '   | 1 | 2 |'].join('\n'),
      { maxWidth: 600 },
    );

    expect(walk(md.content).filter((e) => e instanceof Table).length).toBe(1);
    // Cell pipes must not survive as literal text.
    expect(textOf(md.content)).not.toContain('| a | b |');
  });

  it('keeps the single-RichText fast path for an all-inline item', () => {
    // This is the invariant `updateStreamedList` depends on: it reuses
    // `stack.children[i]` via `setSpans`, so an inline-only item must stay ONE
    // entity with spans rather than becoming a Stack.
    const md = new Markdown(['- plain one', '- with `code` and **bold**'].join('\n'), {
      maxWidth: 600,
    });
    const list = md.content.children[0];
    expect(list.children.length).toBe(2);
    for (const item of list.children) {
      expect(Array.isArray((item as any).spans)).toBe(true);
      expect(typeof (item as any).setSpans).toBe('function');
    }
  });

  it('still renders the marker for an item that has a block child', () => {
    const md = new Markdown(['1. Ordered.', '   $$x=1$$', '2. Second.'].join('\n'), {
      maxWidth: 600,
    });
    const text = textOf(md.content);
    expect(text).toContain('1.');
    expect(text).toContain('2.');
  });

  it('promotes an item off the fast path when its formula closes mid-stream', () => {
    // The streamed path is separate code with its own reuse guards. While `$$x=1`
    // is still open the item is inline-only and reuses one `RichText`; the moment
    // the closing `$$` lands it holds a `blockMath` and MUST be rebuilt as a
    // Stack, or the reuse writes spans onto an entity of the wrong shape.
    const md = new Markdown('1. Solver.', { maxWidth: 600 });
    const listOf = () => md.content.children[0] as any;
    expect(Array.isArray(listOf().children[0].spans)).toBe(true);

    md.appendMarkdown('\n   $$x=1');
    md.appendMarkdown('$$');

    // The formula is now typeset, and its TeX is not painted as text.
    expect(imagesOf(md.content).length).toBe(1);
    expect(textOf(md.content)).not.toContain('$$');
    expect(textOf(md.content)).toContain('Solver.');
  });

  it('keeps appending inline items after one item gained a block', () => {
    // Mixed list: the reuse path has to tier per item, not per list.
    const md = new Markdown('1. First.\n   $$a=1$$\n', { maxWidth: 600 });
    md.appendMarkdown('2. Second.\n');
    md.appendMarkdown('3. Third.\n');

    const text = textOf(md.content);
    expect(text).toContain('First.');
    expect(text).toContain('Second.');
    expect(text).toContain('Third.');
    expect(text).not.toContain('a=1');
    expect(imagesOf(md.content).length).toBe(1);
  });

  it("reproduces the real document's shape: CJK bold intro, then indented $$", () => {
    // Condensed from the 60-line document that exposed this. Nine of its ten
    // display formulas sat at indent 2 inside `*` items exactly like this and
    // rendered as literal TeX; the tenth, at indent 0, rendered fine. The
    // discriminator was list membership, not the formula.
    const md = new Markdown(
      [
        '* **数学模型**：坐标系变换表示为一个 $3 \\times 3$ 的仿射矩阵：',
        '  $$M = \\begin{bmatrix} s_x & 0 \\\\ 0 & s_y \\end{bmatrix}$$',
        '* **级联计算**：利用矩阵乘法的结合律：',
        '  $$M_{global} = M_{parent} \\times M_{local}$$',
      ].join('\n'),
      { maxWidth: 900 },
    );

    // Two display formulas typeset, and no `$$` left anywhere as text.
    expect(imagesOf(md.content).length).toBe(2);
    const text = textOf(md.content);
    expect(text).not.toContain('$$');
    expect(text).not.toContain('begin{bmatrix}');
    // Inline math on the intro line is untouched (it always worked).
    expect(text).toContain('数学模型');
    expect(text).toContain('级联计算');
  });

  it('leaves `$$…$$ trailing text` inline, as it is at top level too', () => {
    // NOT a list defect and deliberately not "fixed" here. A block construct owns
    // its whole line, so `$$x$$ (note)` is not display math at indent 0 either --
    // verified: top level yields [paragraph, text] with no blockMath. The tenth
    // formula in the real document is this shape. Asserted so the boundary is
    // explicit rather than looking like an oversight.
    const md = new Markdown('* **A**: text\n  $$H = x$$ (其中 $p$ 为大质数)。', {
      maxWidth: 900,
    });
    expect(imagesOf(md.content).length).toBe(0);
  });

  it('renders a nested list under a paragraph in the same item', () => {
    const md = new Markdown(['1. Parent item', '   - child one', '   - child two'].join('\n'), {
      maxWidth: 600,
    });
    const text = textOf(md.content);
    expect(text).toContain('Parent item');
    expect(text).toContain('child one');
    expect(text).toContain('child two');
  });
});
