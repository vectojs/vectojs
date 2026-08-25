import { describe, expect, it } from 'vitest';
import { Markdown, resolvePresetTheme } from '../src/Markdown';

describe('Markdown.setTheme (#781 follow-up)', () => {
  it('resolves a preset name and exposes it through the theme getter', () => {
    const md = new Markdown('# hi', { theme: 'githubLight' });
    md.setTheme('dracula');
    expect(md.theme).toEqual(resolvePresetTheme('dracula'));
  });

  it('merges a partial theme object over the active theme', () => {
    const md = new Markdown('# hi', { theme: 'githubDark' });
    const base = { ...md.theme };
    md.setTheme({ blockGap: 33 });
    expect(md.theme.blockGap).toBe(33);
    // Unspecified tokens survive the merge.
    expect(md.theme.textColor).toBe(base.textColor);
  });

  it('carries blockGap onto the content Stack gap', () => {
    const md = new Markdown('a\n\nb', { theme: 'githubLight' });
    md.setTheme({ blockGap: 41 });
    // Stack gap is public on @vectojs/ui; reach it via the first child.
    const stack = (md as unknown as { content: { gap: number } }).content;
    expect(stack.gap).toBe(41);
  });

  it('rebuilds through setContent so rendered children exist afterwards', () => {
    const md = new Markdown('# title\n\nbody text');
    md.setTheme('solarizedDark');
    const children = (md as unknown as { content: { children: unknown[] } }).content.children;
    expect(children.length).toBeGreaterThan(0);
  });

  it('keeps direct assignment a compile-time error and a runtime TypeError', () => {
    const md = new Markdown('x');
    expect(() => {
      // @ts-expect-error -- theme is getter-only by design (#657); setTheme is the path
      (md as unknown as { theme: unknown }).theme = resolvePresetTheme('dracula');
    }).toThrow(TypeError);
  });
});
