import { Entity } from '@vecto-ui/core';
import { marked, Token, Tokens } from 'marked';
import { Stack } from './Stack';
import { Text } from './Text';
import { UIComponent } from './UIComponent';

/**
 * Renders Markdown content into a VectoUI node tree using marked.js.
 */
export class Markdown extends UIComponent {
  public content: Stack;
  public maxWidth: number;

  constructor(markdownText: string, opts: { maxWidth?: number } = {}) {
    super('Markdown');
    this.maxWidth = opts.maxWidth ?? 800;

    this.content = new Stack({ direction: 'vertical', gap: 16 });
    this.add(this.content);

    this.renderMarkdown(markdownText);
  }

  private renderMarkdown(text: string) {
    const tokens = marked.lexer(text);
    for (const token of tokens) {
      const el = this.renderToken(token);
      if (el) {
        this.content.add(el);
      }
    }

    // Size to fit content
    this.width = this.content.width;
    this.height = this.content.height;
  }

  private renderToken(token: Token): Entity | null {
    switch (token.type) {
      case 'heading': {
        const hToken = token as Tokens.Heading;
        const size = Math.max(16, 32 - (hToken.depth - 1) * 4); // h1=32, h2=28...
        return new Text(hToken.text, {
          font: `bold ${size}px sans-serif`,
          maxWidth: this.maxWidth,
        });
      }
      case 'paragraph': {
        const pToken = token as Tokens.Paragraph;
        // Simple text block for now
        // A full implementation would parse inline tokens (strong, em, link)
        return new Text(pToken.text, {
          font: '16px sans-serif',
          lineHeight: 24,
          maxWidth: this.maxWidth,
        });
      }
      case 'space':
        return null; // Skip empty space
      case 'code': {
        const codeToken = token as Tokens.Code;
        // TODO: wrap in a Card
        return new Text(codeToken.text, {
          font: '14px monospace',
          color: '#00ff00', // Hacker green code
          maxWidth: this.maxWidth - 32, // Padding
        });
      }
      case 'list': {
        const listToken = token as Tokens.List;
        const listStack = new Stack({ direction: 'vertical', gap: 8 });
        for (const item of listToken.items) {
          const itemText = new Text('• ' + item.text, {
            font: '16px sans-serif',
            maxWidth: this.maxWidth - 20, // Bullet indent
          });
          listStack.add(itemText);
        }
        return listStack;
      }
      // Expand with link, image, blockquote as needed
      default:
        // Fallback for unsupported tokens
        if ('text' in token) {
          return new Text((token as any).text, {
            font: '16px sans-serif',
            maxWidth: this.maxWidth,
          });
        }
        return null;
    }
  }

  public render(): void {}
}
