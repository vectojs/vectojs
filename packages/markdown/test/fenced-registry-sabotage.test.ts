import { describe, it, expect, beforeEach } from 'vitest';
import { Markdown, unregisterFencedBlockRenderer } from '../src/Markdown';
import { CodeBlock } from '../src/markdown-code';

/**
 * Sabotage tests: verify that the fenced block registry gracefully falls back
 * to default code block rendering when a renderer is missing or fails.
 */
describe('FencedBlockRegistry - Sabotage', () => {
  describe('unregistered renderer fallback', () => {
    beforeEach(() => {
      // Unregister the JavaScript renderer to test fallback
      unregisterFencedBlockRenderer('javascript');
    });

    it('falls back to CodeBlock when renderer is unregistered', () => {
      const md = new Markdown({
        text: '```javascript\nconst x = 42;\n```',
        width: 800,
      });

      // Should render as a CodeBlock (fallback), not throw
      expect(md.children.length).toBeGreaterThan(0);
      const firstChild = md.children[0];
      expect(firstChild).toBeInstanceOf(CodeBlock);
    });

    it('handles unknown language gracefully', () => {
      const md = new Markdown({
        text: '```unknown-lang\nsome code\n```',
        width: 800,
      });

      // Should render as a CodeBlock (fallback), not throw
      expect(md.children.length).toBeGreaterThan(0);
      const firstChild = md.children[0];
      expect(firstChild).toBeInstanceOf(CodeBlock);
    });

    it('handles empty fence with unregistered renderer', () => {
      const md = new Markdown({
        text: '```javascript\n```',
        width: 800,
      });

      // Empty fence should either render as CodeBlock or be skipped
      // Either way, it should not throw
      expect(() => md.render()).not.toThrow();
    });
  });

  describe('math renderer fallback', () => {
    beforeEach(() => {
      // Unregister math renderer to test fallback
      unregisterFencedBlockRenderer('math');
      unregisterFencedBlockRenderer('latex');
      unregisterFencedBlockRenderer('tex');
    });

    it('falls back to CodeBlock when math renderer is unregistered', () => {
      const md = new Markdown({
        text: '```math\nE = mc^2\n```',
        width: 800,
      });

      // Should render as a CodeBlock (fallback), not throw
      expect(md.children.length).toBeGreaterThan(0);
      const firstChild = md.children[0];
      expect(firstChild).toBeInstanceOf(CodeBlock);
    });

    it('handles unclosed math fence gracefully', () => {
      const md = new Markdown({
        text: '```math\nE = mc^2',
        width: 800,
        mode: 'incomplete',
      });

      // Unclosed fence should render as CodeBlock showing TeX source
      expect(md.children.length).toBeGreaterThan(0);
      const firstChild = md.children[0];
      expect(firstChild).toBeInstanceOf(CodeBlock);
    });
  });
});
