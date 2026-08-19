// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { Markdown } from '../src/Markdown';

function paragraphs(n: number): string {
  const parts: string[] = [];
  for (let i = 0; i < n; i++) {
    parts.push(`Paragraph ${i} with enough prose to wrap onto a couple of lines.`);
  }
  return parts.join('\n\n');
}

describe('Markdown virtualize', () => {
  it('mounts only a window of blocks and reports full estimated height', () => {
    const doc = paragraphs(300);
    const plain = new Markdown(doc, { maxWidth: 600 });
    const virtual = new Markdown(doc, { maxWidth: 600, virtualize: { overscan: 100 } });

    // Plain path materializes every top-level block.
    expect(plain.content.children.length).toBe(300);

    // Virtualized path keeps only the window near the initial (top) viewport.
    virtual.setVisibleRange(0, 400);
    expect(virtual.content.children.length).toBeGreaterThan(0);
    expect(virtual.content.children.length).toBeLessThan(300);

    // Total height is positive and in the same order of magnitude as the real
    // (fully laid-out) document — estimates are coarse, not wildly off.
    expect(virtual.height).toBeGreaterThan(0);
    expect(virtual.height).toBeGreaterThan(plain.height * 0.3);
    expect(virtual.height).toBeLessThan(plain.height * 3);

    // At the top, no skipped prefix, so the numeric spacer offset is zero.
    expect(virtual.content.y).toBe(0);
  });

  it('moves the materialized window as the viewport scrolls', () => {
    const doc = paragraphs(300);
    const virtual = new Markdown(doc, { maxWidth: 600, virtualize: { overscan: 100 } });

    virtual.setVisibleRange(0, 400);
    expect(virtual.content.y).toBe(0);

    virtual.setVisibleRange(4000, 400);
    // The skipped prefix is now non-zero — the numeric spacer is doing its job —
    // and the window still has content mounted.
    expect(virtual.content.y).toBeGreaterThan(0);
    expect(virtual.content.children.length).toBeGreaterThan(0);
    // The spacer is strictly less than the total height (we are not at the very end).
    expect(virtual.content.y).toBeLessThan(virtual.height);
  });

  it('materializes the tail blocks when scrolled to the bottom', () => {
    const doc = paragraphs(300);
    const virtual = new Markdown(doc, { maxWidth: 600, virtualize: { overscan: 100 } });

    virtual.setVisibleRange(virtual.height, 400);
    // At the bottom, the mounted window ends at the last block, and the spacer
    // plus the mounted window height add up to the total document height.
    expect(virtual.content.children.length).toBeGreaterThan(0);
    expect(virtual.content.y + virtual.content.height).toBeGreaterThanOrEqual(virtual.height);
  });

  it('setVisibleRange is a no-op when virtualize is disabled', () => {
    const md = new Markdown(paragraphs(50), { maxWidth: 600 });
    const before = md.content.children.length;
    md.setVisibleRange(0, 10);
    md.setVisibleRange(5000, 10);
    expect(md.content.children.length).toBe(before);
  });

  it('rejects streaming on a virtualized document', () => {
    const md = new Markdown('# Hello', { virtualize: true });
    expect(() => md.appendMarkdown('\n\nmore')).toThrow(/virtualize/);
    expect(() => md.createStream()).toThrow(/virtualize/);
  });

  it('retains streamed blocks while bounding the default content draw range', () => {
    const md = new Markdown('', { maxWidth: 600 });
    md.appendMarkdown(paragraphs(300));

    const range = md.content.getRenderChildRange({
      x: 0,
      y: 4000,
      width: 600,
      height: 400,
    });

    expect(md.content.children).toHaveLength(300);
    expect(range).not.toBeNull();
    expect(range!.end - range!.start).toBeLessThan(30);
  });

  it('setMaxWidth re-estimates and re-mounts the window', () => {
    const doc = paragraphs(300);
    const virtual = new Markdown(doc, { maxWidth: 600, virtualize: { overscan: 100 } });
    virtual.setVisibleRange(0, 400);

    virtual.setMaxWidth(200);

    // A narrower column wraps more, so the document grows and the window is still
    // a strict subset of the whole document.
    expect(virtual.height).toBeGreaterThan(0);
    expect(virtual.content.children.length).toBeGreaterThan(0);
    expect(virtual.content.children.length).toBeLessThan(300);
  });
});
