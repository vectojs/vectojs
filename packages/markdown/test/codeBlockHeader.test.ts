// @vitest-environment jsdom
/**
 * The code-block header band, and the configurable affordance controls.
 *
 * These two ship together because they are the same defect from two directions.
 * `blockAffordances` placed its controls at y 8-32 while the first line of code
 * occupied y 18-42 in the default theme — measured, a 14px overlap, so a block
 * with controls had its first line drawn under them. The header band reserves
 * that space, which is why it is a fix and not only a label.
 *
 * The invariant the band must not break is the one `CodeBlock.setWidth()`
 * documents: `height` stays a function of line COUNT, with no dependency on
 * width. A reserved band changes the constant term, nothing else.
 */
import { describe, expect, it } from 'vitest';
import { CodeBlock, Markdown } from '../src/Markdown';
import type { BlockAffordanceButton } from '../src/blockAffordances';
import { resolveBlockAffordanceConfig } from '../src/blockAffordances';

/** Reads the private geometry the header shifts. */
interface Probe {
  headerHeight: () => number;
  contentTop: () => number;
  languageLabel: () => string;
  pad: number;
  lineH: number;
}

const probe = (cb: CodeBlock): Probe => cb as unknown as Probe;

describe('CodeBlock language header', () => {
  it('reserves no space and shows nothing by default', () => {
    // The default has to stay byte-identical to the pre-header behaviour: every
    // existing document's code blocks would otherwise silently grow taller.
    const plain = new CodeBlock('const x = 1;', 'ts', 400, 'default');
    expect(probe(plain).headerHeight()).toBe(0);
    expect(probe(plain).contentTop()).toBe(probe(plain).pad);
  });

  it('reserves a band and offsets the first line when enabled', () => {
    const withHeader = new CodeBlock('const x = 1;', 'ts', 400, 'default', true, {
      showLanguage: true,
    });
    const p = probe(withHeader);
    expect(p.headerHeight()).toBeGreaterThan(0);
    expect(p.contentTop()).toBe(p.headerHeight() + p.pad);
  });

  it('grows the block by exactly the band height', () => {
    const code = 'a\nb\nc';
    const plain = new CodeBlock(code, 'ts', 400, 'default');
    const withHeader = new CodeBlock(code, 'ts', 400, 'default', true, { showLanguage: true });
    expect(withHeader.height - plain.height).toBe(probe(withHeader).headerHeight());
  });

  it('keeps height a function of line count, not width', () => {
    // The invariant `setWidth()` documents. A band that participated in width
    // would break the promise that a resize rebuilds neither grid nor highlight.
    const cb = new CodeBlock('a\nb\nc', 'ts', 400, 'default', true, { showLanguage: true });
    const before = cb.height;
    cb.setWidth(120);
    expect(cb.height).toBe(before);
    cb.setWidth(2000);
    expect(cb.height).toBe(before);
  });

  it('normalizes the label the same way the highlighter normalizes its key', () => {
    // A fence may be `Bash`, or carry attributes. The label must be the language,
    // and must agree with what the colouring resolved — one normalization, not two.
    expect(probe(new CodeBlock('x', 'Bash', 400, 'default')).languageLabel()).toBe('bash');
    expect(probe(new CodeBlock('x', 'ts title="a.ts"', 400, 'default')).languageLabel()).toBe('ts');
  });

  it('reserves nothing for a bare fence with no language', () => {
    // Asked for, but there is nothing to name: a band painted empty is worse than
    // no band, because the reader sees unexplained space above the code.
    const bare = new CodeBlock('plain text', '', 400, 'default', true, { showLanguage: true });
    expect(probe(bare).headerHeight()).toBe(0);
  });

  it('is off by default on a document and on when asked', () => {
    const off = new Markdown('```ts\nconst x = 1;\n```');
    const on = new Markdown('```ts\nconst x = 1;\n```', { showCodeLanguage: true });
    const block = (md: Markdown) => md.content.children[0] as unknown as CodeBlock;
    expect(probe(block(off)).headerHeight()).toBe(0);
    expect(probe(block(on)).headerHeight()).toBeGreaterThan(0);
  });

  it('clears the overlap that motivated the band', () => {
    // The measured defect: controls at y 8-32 over code starting at y 18. With the
    // band reserved, the first line must start at or below the controls' bottom.
    const md = new Markdown('```ts\nconst x = 1;\n```', {
      showCodeLanguage: true,
      blockAffordances: true,
    });
    const wrapper = md.content.children[0];
    const cb = wrapper.children.find((c) => c instanceof CodeBlock) as CodeBlock;
    const controls = wrapper.children.filter((c) => c !== cb);
    const lowestControlBottom = Math.max(...controls.map((c) => c.y + c.height));
    expect(probe(cb).contentTop()).toBeGreaterThanOrEqual(lowestControlBottom);
  });
});

describe('configurable block affordances', () => {
  const labelsOf = (md: Markdown): string[] => {
    const wrapper = md.content.children[0];
    return wrapper.children
      .filter((c) => c instanceof CodeBlock === false)
      .map((c) => (c as unknown as BlockAffordanceButton).label)
      .filter((l): l is string => typeof l === 'string');
  };

  it('defaults to copy + download, matching the pre-config behaviour', () => {
    const md = new Markdown('```ts\nx\n```', { blockAffordances: true });
    expect(labelsOf(md)).toEqual(['Copy code', 'Download code']);
  });

  it('drops the download control when asked', () => {
    const md = new Markdown('```ts\nx\n```', {
      blockAffordances: true,
      affordances: { download: false },
    });
    expect(labelsOf(md)).toEqual(['Copy code']);
  });

  it('drops the copy control when asked', () => {
    const md = new Markdown('```ts\nx\n```', {
      blockAffordances: true,
      affordances: { copy: false },
    });
    expect(labelsOf(md)).toEqual(['Download code']);
  });

  it('leaves the block unwrapped when every control is disabled', () => {
    // No controls means no wrapper: an empty `BlockWithAffordances` would add a
    // group to the a11y tree announcing nothing.
    const md = new Markdown('```ts\nx\n```', {
      blockAffordances: true,
      affordances: { copy: false, download: false },
    });
    expect(md.content.children[0]).toBeInstanceOf(CodeBlock);
  });

  it('relabels controls for a non-English document', () => {
    // The labels are what a screen reader announces, so they cannot stay
    // hardcoded English for a translated document.
    const md = new Markdown('```ts\nx\n```', {
      blockAffordances: true,
      affordances: { labels: { copyCode: '复制代码', downloadCode: '下载代码' } },
    });
    expect(labelsOf(md)).toEqual(['复制代码', '下载代码']);
  });

  it('applies custom labels to tables too', () => {
    const md = new Markdown('| a |\n| - |\n| 1 |', {
      blockAffordances: true,
      affordances: { labels: { copyTable: 'Copiar', downloadTable: 'Descargar' } },
    });
    const wrapper = md.content.children[0];
    const labels = wrapper.children
      .map((c) => (c as unknown as BlockAffordanceButton).label)
      .filter((l): l is string => typeof l === 'string');
    expect(labels).toEqual(['Copiar', 'Descargar']);
  });

  it('resolves defaults consistently for a caller building controls by hand', () => {
    const resolved = resolveBlockAffordanceConfig();
    expect(resolved.copy).toBe(true);
    expect(resolved.download).toBe(true);
    expect(resolved.labels.copied).toBe('Copied');
    expect(resolved.labels.saved).toBe('Saved');
  });

  it('keeps the success label configurable independently of the resting one', () => {
    // Separate strings rather than derived: no suffix or tense rule survives
    // translation.
    const resolved = resolveBlockAffordanceConfig({ labels: { copied: '已复制' } });
    expect(resolved.labels.copied).toBe('已复制');
    expect(resolved.labels.copyCode).toBe('Copy code');
  });
});
