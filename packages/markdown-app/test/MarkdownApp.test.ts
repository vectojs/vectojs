import { describe, expect, it, vi } from 'vitest';
import { MarkdownApp } from '../src';

describe('MarkdownApp', () => {
  it('keeps source and preview synchronized', () => {
    const onChange = vi.fn();
    const app = new MarkdownApp({
      width: 900,
      height: 600,
      initialContent: '# Initial',
      onChange,
    });

    app.setContent('## Updated');

    expect(app.source.value).toBe('## Updated');
    expect(app.preview.content.children.length).toBeGreaterThan(0);
    expect(onChange).toHaveBeenCalledWith('## Updated');
  });

  it('lays out a reader-only preview and switches themes', () => {
    const app = new MarkdownApp({
      width: 800,
      height: 500,
      editable: false,
      initialContent: '# Reader',
      theme: 'githubDark',
    });

    app.setTheme('githubLight');

    expect(app.editable).toBe(false);
    expect(app.source.opacity).toBe(0);
    expect(app.theme).toBe('githubLight');
    expect(app.preview.theme.textColor).toBe('#1f2328');
    expect(app.previewScroll.width).toBeGreaterThan(0);
  });

  it('resizes the preview without replacing its entity', () => {
    const app = new MarkdownApp({ width: 1000, height: 700, initialContent: '# Resize' });
    const preview = app.preview;

    app.setSize(720, 480);

    expect(app.preview).toBe(preview);
    expect(app.previewScroll.height).toBe(480 - app.toolbarHeight);
    expect(app.source.width).toBeGreaterThan(0);
  });

  it('updates the toolbar title without rebuilding the app', () => {
    const app = new MarkdownApp({ initialTitle: 'Draft' });

    app.setTitle('Published');

    expect(app.title).toBe('Published');
  });
});
