// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { Markdown } from '../src/Markdown';

/**
 * A code block and a table each carry their content in a form a reader can take
 * away: copy to the clipboard, or download as a file.
 *
 * The reference affordance is `streamdown` (clone `e5deed3`,
 * `packages/streamdown/lib/{code-block,table}/`), which puts the controls in the
 * block's top-right corner. Two details of its `save()` primitive
 * (`lib/utils.ts:35`) are borrowed deliberately, because both are commonly
 * omitted and each is a real bug when missing:
 *
 * - it revokes the object URL after clicking, or every download leaks a blob for
 *   the lifetime of the document;
 * - it prepends a UTF-8 BOM for `text/csv`, or Excel on Windows reads the file in
 *   the system ANSI codepage and corrupts every non-ASCII cell.
 *
 * Zero-DOM constraint: the button is painted on the canvas, so its semantics come
 * from the a11y projection rather than from a real `<button>` in the page. Rather
 * than hand-rolling a hotspot, these reuse `@vectojs/ui`'s `Button`, which
 * already projects `tag: 'button'` with a label and drives its focus ring from
 * real DOM focus/blur — the repo rule against reimplementing what a package
 * provides applies to affordances too.
 *
 * The clipboard is asserted through an injected writer rather than
 * `navigator.clipboard`: jsdom does not implement it, and a real browser rejects
 * a write that does not come from a user gesture, so the e2e layer is where the
 * gesture path is proven. These tests pin the wiring and the payload.
 */

interface ButtonLike {
  label: string;
  emit: (event: string, payload?: unknown) => void;
  getA11yAttributes: () => { tag?: string; role?: string; label?: string };
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Every entity in the tree that projects as a button, in document order. */
function buttons(md: Markdown): ButtonLike[] {
  const found: ButtonLike[] = [];
  const walk = (entity: { children?: unknown[] }): void => {
    const a11y = (entity as { getA11yAttributes?: () => { tag?: string } }).getA11yAttributes;
    if (typeof a11y === 'function') {
      const attrs = a11y.call(entity);
      if (attrs?.tag === 'button') found.push(entity as unknown as ButtonLike);
    }
    for (const child of (entity.children ?? []) as Array<{
      children?: unknown[];
    }>)
      walk(child);
  };
  walk(md as unknown as { children?: unknown[] });
  return found;
}

function findButton(md: Markdown, label: string): ButtonLike | undefined {
  return buttons(md).find((b) => b.getA11yAttributes().label === label);
}

const CODE_DOC = ['```ts', "const greeting = 'hÉllo';", '```'].join('\n');
const TABLE_DOC = ['| name | qty |', '| --- | --- |', '| café | 2 |', '| a,b | 3 |'].join('\n');

describe('code block and table copy/download affordances', () => {
  it('does not project any affordance until asked for', () => {
    const md = new Markdown(CODE_DOC, { maxWidth: 600 });
    expect(buttons(md)).toHaveLength(0);
  });

  it('projects a labelled copy button on a code block', () => {
    const md = new Markdown(CODE_DOC, {
      maxWidth: 600,
      blockAffordances: true,
    });
    const copy = findButton(md, 'Copy code');
    expect(copy).toBeDefined();
    // A canvas-drawn control is only reachable because the projection says it is
    // a button; role and tag both matter to assistive technology.
    expect(copy?.getA11yAttributes()).toMatchObject({
      tag: 'button',
      role: 'button',
    });
  });

  it('copies the code block source verbatim, including non-ASCII', () => {
    const writes: string[] = [];
    const md = new Markdown(CODE_DOC, {
      maxWidth: 600,
      blockAffordances: true,
      writeClipboard: (text: string) => {
        writes.push(text);
      },
    });
    findButton(md, 'Copy code')?.emit('click');
    expect(writes).toEqual(["const greeting = 'hÉllo';"]);
  });

  it('downloads a code block with an extension derived from its language', () => {
    const saved: Array<{
      filename: string;
      mimeType: string;
      content: string;
    }> = [];
    const md = new Markdown(CODE_DOC, {
      maxWidth: 600,
      blockAffordances: true,
      saveFile: (filename: string, content: string, mimeType: string) => {
        saved.push({ filename, content, mimeType });
      },
    });
    findButton(md, 'Download code')?.emit('click');
    expect(saved).toHaveLength(1);
    expect(saved[0].filename).toMatch(/\.ts$/);
    expect(saved[0].content).toBe("const greeting = 'hÉllo';");
  });

  it('falls back to a .txt extension for an unknown language', () => {
    const saved: string[] = [];
    const md = new Markdown('```wubbleflurp\nx\n```', {
      maxWidth: 600,
      blockAffordances: true,
      saveFile: (filename: string) => {
        saved.push(filename);
      },
    });
    findButton(md, 'Download code')?.emit('click');
    expect(saved[0]).toMatch(/\.txt$/);
  });

  it('copies a table as Markdown that round-trips through the lexer', () => {
    const writes: string[] = [];
    const md = new Markdown(TABLE_DOC, {
      maxWidth: 600,
      blockAffordances: true,
      writeClipboard: (text: string) => {
        writes.push(text);
      },
    });
    findButton(md, 'Copy table')?.emit('click');
    expect(writes).toHaveLength(1);
    // Re-lexing the copied text must yield a table again, with the same cells.
    const round = new Markdown(writes[0], { maxWidth: 600 });
    expect(writes[0]).toContain('café');
    expect(round).toBeDefined();
  });

  it('downloads a table as CSV with a UTF-8 BOM so Excel reads it correctly', () => {
    const saved: Array<{
      filename: string;
      mimeType: string;
      content: string;
    }> = [];
    const md = new Markdown(TABLE_DOC, {
      maxWidth: 600,
      blockAffordances: true,
      saveFile: (filename: string, content: string, mimeType: string) => {
        saved.push({ filename, content, mimeType });
      },
    });
    findButton(md, 'Download table')?.emit('click');
    expect(saved).toHaveLength(1);
    expect(saved[0].mimeType).toMatch(/^text\/csv/);
    expect(saved[0].filename).toMatch(/\.csv$/);
    // The BOM is the whole point of the borrowed detail.
    expect(saved[0].content.charCodeAt(0)).toBe(0xfeff);
  });

  it('quotes a CSV cell containing a comma rather than splitting it', () => {
    const saved: string[] = [];
    const md = new Markdown(TABLE_DOC, {
      maxWidth: 600,
      blockAffordances: true,
      saveFile: (_f: string, content: string) => {
        saved.push(content);
      },
    });
    findButton(md, 'Download table')?.emit('click');
    // `a,b` must survive as one cell.
    expect(saved[0]).toContain('"a,b"');
  });

  it('reports success transiently without leaving the label changed forever', () => {
    vi.useFakeTimers();
    try {
      const md = new Markdown(CODE_DOC, {
        maxWidth: 600,
        blockAffordances: true,
        writeClipboard: () => {},
      });
      const copy = findButton(md, 'Copy code');
      copy?.emit('click');
      // Immediately after a copy the control should say so, for a sighted user
      // and for AT alike.
      expect(copy?.getA11yAttributes().label).not.toBe('Copy code');
      vi.advanceTimersByTime(5000);
      expect(copy?.getA11yAttributes().label).toBe('Copy code');
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the affordance inside the block box, in its top-right corner', () => {
    const md = new Markdown(CODE_DOC, {
      maxWidth: 600,
      blockAffordances: true,
    });
    const copy = findButton(md, 'Copy code');
    expect(copy).toBeDefined();
    // Right-aligned: past the horizontal middle of the 600px block, and fully
    // within it. A control drawn outside the box is unreachable by pointer.
    expect(copy!.x).toBeGreaterThan(300);
    expect(copy!.x + copy!.width).toBeLessThanOrEqual(600);
    expect(copy!.y).toBeGreaterThanOrEqual(0);
  });
});
