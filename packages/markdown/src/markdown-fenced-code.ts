import type { Entity } from '@vectojs/core';
import { CodeBlock } from './markdown-code';
import type { FencedBlockRenderer, FencedBlockRenderOptions } from './markdown-fenced-registry';

/**
 * Built-in code block renderer for the fenced block registry.
 *
 * Wraps the existing `CodeBlock` entity, preserving all current behavior
 * (syntax highlighting, content projection, text selection). Registered for
 * common programming languages.
 *
 * This is a synchronous renderer with no lazy load — it is registered with an
 * immediate `load()` that returns the renderer function directly.
 */

export const codeBlockRenderer: FencedBlockRenderer = (
  source: string,
  lang: string,
  options: FencedBlockRenderOptions,
): Entity | null => {
  if (!source) return null;
  return new CodeBlock(source, lang, options.availableWidth, options.theme, options.selectable);
};

/**
 * Languages that render as code blocks.
 *
 * This is a non-exhaustive list of common programming languages. Any language
 * not explicitly claimed by another renderer (math, mermaid, …) falls back to
 * code block rendering, so an unlisted language still works — this set exists
 * only to make the common case explicit.
 */
export const CODE_BLOCK_LANGS = new Set([
  'javascript',
  'js',
  'typescript',
  'ts',
  'jsx',
  'tsx',
  'python',
  'py',
  'rust',
  'rs',
  'go',
  'java',
  'c',
  'cpp',
  'c++',
  'csharp',
  'cs',
  'ruby',
  'rb',
  'php',
  'swift',
  'kotlin',
  'scala',
  'shell',
  'sh',
  'bash',
  'zsh',
  'fish',
  'powershell',
  'sql',
  'html',
  'css',
  'scss',
  'sass',
  'less',
  'json',
  'yaml',
  'yml',
  'toml',
  'xml',
  'markdown',
  'md',
  'text',
  'txt',
  'plaintext',
]);
