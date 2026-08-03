/**
 * Browser fixture for `set-max-width.e2e.ts`.
 *
 * Streams a document, resizes mid-stream via `Markdown.setMaxWidth`, and reports
 * what survived. The point of the API is that the resize is *not* a rebuild, so
 * the probe records entity identity, stream state and lexer work rather than only
 * geometry — a rebuild would produce correct geometry too, which is exactly how a
 * consumer ended up hand-rolling one and paying for it on every resize frame.
 */
import { Scene } from '@vectojs/core';
import type { RichText } from '@vectojs/ui';
import { Markdown } from '../src/Markdown';
import type { StreamController } from '../src/StreamController';

const canvas = document.querySelector('canvas');
if (!(canvas instanceof HTMLCanvasElement)) throw new Error('fixture needs a canvas');

/**
 * A scratch 2D context for measuring projected line advances.
 *
 * Separate from the scene's canvas so assigning `font` here cannot disturb the
 * renderer's own cached font state mid-frame.
 */
const measureCtx = document.createElement('canvas').getContext('2d');
if (!measureCtx) throw new Error('fixture needs a 2D context to measure line widths');

const scene = new Scene(canvas, { disableWindowResize: true });
const markdown = new Markdown('', { maxWidth: 520 });
markdown.setPosition(20, 20);
scene.add(markdown);
scene.start();

let stream: StreamController | null = null;

/** Identity token per top-level child, so a rebuild is detectable from outside. */
const ids = new WeakMap<object, number>();
let nextId = 1;
function identity(entity: object): number {
  let id = ids.get(entity);
  if (id === undefined) {
    id = nextId++;
    ids.set(entity, id);
  }
  return id;
}

export interface WidthProbe {
  /** `Markdown.maxWidth`. */
  maxWidth: number;
  /** Laid-out document box. */
  documentWidth: number;
  documentHeight: number;
  /** Per-top-level-child identity tokens, in order. */
  childIds: number[];
  /** Per-child `maxWidth` where the child exposes one, else `null`. */
  childWidths: Array<number | null>;
  /**
   * Projected visual lines summed over every text entity — the real wrap evidence.
   *
   * Read from `getContentProjection()`, the public selection geometry, rather than
   * from the private layout result: it is what a browser `Range` actually selects,
   * so a reflow that moved the entity box but left the projection stale is caught
   * here rather than passing.
   */
  projectedLines: number;
  /** Widest projected line box, in CSS pixels. */
  widestLine: number;
  /** `'open' | 'closed' | ...` of the stream, or `null` when there is none. */
  streamState: string | null;
  /** Concatenated visible text, to prove nothing was lost. */
  text: string;
  /** Source characters the lexer has consumed since the page loaded. */
  sourceCharsLexed: number;
  /** Top-level token count. */
  tokens: number;
}

function fieldNumber(groups: unknown, label: string): number {
  for (const group of groups as Array<{
    fields: Array<{ label: string; value: unknown }>;
  }>) {
    for (const field of group.fields) {
      if (field.label === label && typeof field.value === 'number') return field.value;
    }
  }
  return -1;
}

function probe(): WidthProbe {
  const children = markdown.content.children;
  const descriptor = markdown.getDevtoolsDescriptor();
  let widestLine = 0;
  let projectedLines = 0;
  const text: string[] = [];
  const walk = (node: { children: unknown[] }): void => {
    for (const child of node.children) {
      const rich = child as RichText;
      if (Array.isArray(rich.spans)) {
        text.push(rich.spans.map((span) => span.text).join(''));
        const projection = rich.getContentProjection?.();
        for (const line of projection?.lines ?? []) {
          projectedLines++;
          // Measure the projected text with the projected font rather than summing
          // `run.width`: that field is only populated for justified text (it exists
          // to size a positioned carrier), so for ordinary left-aligned prose it
          // sums to 0 and an assertion built on it is vacuous — measured exactly
          // that, `widest 0.0`, on the first run of this gate.
          const lineText = line.runs?.length
            ? line.runs.map((run) => run.text).join('')
            : line.text;
          const font = line.runs?.[0]?.font ?? line.font ?? projection?.font;
          if (lineText && font) {
            measureCtx.font = font;
            const advance = measureCtx.measureText(lineText).width;
            if (advance > widestLine) widestLine = advance;
          }
        }
      }
      walk(child as { children: unknown[] });
    }
  };
  walk(markdown as unknown as { children: unknown[] });

  return {
    maxWidth: markdown.maxWidth,
    documentWidth: markdown.width,
    documentHeight: markdown.height,
    childIds: children.map((child) => identity(child)),
    childWidths: children.map((child) => {
      const value = (child as unknown as { maxWidth?: number; width?: number }).maxWidth;
      return typeof value === 'number' && Number.isFinite(value) ? value : null;
    }),
    projectedLines,
    widestLine,
    streamState: stream ? stream.state : null,
    text: text.join(' '),
    sourceCharsLexed: fieldNumber(descriptor.groups, 'sourceCharsLexed'),
    tokens: fieldNumber(descriptor.groups, 'topLevelTokens'),
  };
}

Object.assign(window as unknown as Record<string, unknown>, {
  __widthProbe: probe,
  __openStream: () => {
    stream = markdown.createStream({ incompleteMode: 'optimistic' });
  },
  __write: (chunk: string) => stream?.write(chunk),
  __close: async () => {
    await stream?.close();
  },
  __setMaxWidth: (width: number) => markdown.setMaxWidth(width),
  __ready: true,
});
