/**
 * Take-away affordances for block content: copy to the clipboard, download as a
 * file.
 *
 * Split out of `Markdown.ts` rather than added to it because none of this is
 * parsing or rendering — it is serialization plus two platform primitives — and
 * that file is already 4.8k lines.
 *
 * The reference implementation is `streamdown` (clone `e5deed3`,
 * `packages/streamdown/lib/`), read and recorded in
 * `vectojs-docs/forge/findings/upstream/README.md`. Two details of its `save()`
 * (`lib/utils.ts:35`) are borrowed deliberately: revoking the object URL, and the
 * UTF-8 BOM for CSV. Both are commonly omitted and each is a real defect when
 * missing — the first leaks a blob for the document's lifetime, the second makes
 * Excel on Windows read the file in the system ANSI codepage and corrupt every
 * non-ASCII cell.
 */

import type { A11yAttributes, Entity, LayoutControlledProperty } from '@vectojs/core';
import { Button, type ButtonOptions, measureText, UIComponent } from '@vectojs/ui';

/**
 * Filename extension for a fenced block's info string.
 *
 * Deliberately a small map rather than `streamdown`'s ~200 entries: this covers
 * what a Markdown document realistically fences, and an unknown language gets
 * `.txt`, which is correct rather than merely a fallback — a file whose type we
 * cannot name is a text file. Add entries when a real document needs one.
 */
const LANGUAGE_EXTENSIONS: Readonly<Record<string, string>> = {
  bash: 'sh',
  c: 'c',
  cpp: 'cpp',
  cs: 'cs',
  css: 'css',
  diff: 'diff',
  dockerfile: 'dockerfile',
  go: 'go',
  graphql: 'graphql',
  haskell: 'hs',
  html: 'html',
  java: 'java',
  javascript: 'js',
  js: 'js',
  json: 'json',
  jsonc: 'jsonc',
  jsx: 'jsx',
  kotlin: 'kt',
  latex: 'tex',
  lua: 'lua',
  make: 'mk',
  markdown: 'md',
  md: 'md',
  nix: 'nix',
  php: 'php',
  python: 'py',
  py: 'py',
  ruby: 'rb',
  rust: 'rs',
  rs: 'rs',
  scss: 'scss',
  sh: 'sh',
  shell: 'sh',
  sql: 'sql',
  svelte: 'svelte',
  swift: 'swift',
  tex: 'tex',
  toml: 'toml',
  ts: 'ts',
  tsx: 'tsx',
  typescript: 'ts',
  vue: 'vue',
  xml: 'xml',
  yaml: 'yaml',
  yml: 'yaml',
  zig: 'zig',
  zsh: 'sh',
};

/** Extension for a fence info string, without the dot. `txt` when unrecognised. */
export function extensionForLanguage(lang: string): string {
  // A fence may carry more than a language (`ts title="x"`), and casing varies.
  const first =
    lang
      .trim()
      .toLowerCase()
      .split(/[\s:,{]/)[0] ?? '';
  return LANGUAGE_EXTENSIONS[first] ?? 'txt';
}

/** MIME type for a downloaded code block. */
export function mimeForLanguage(lang: string): string {
  const ext = extensionForLanguage(lang);
  if (ext === 'json' || ext === 'jsonc') return 'application/json';
  if (ext === 'html') return 'text/html';
  if (ext === 'css') return 'text/css';
  if (ext === 'xml' || ext === 'svelte' || ext === 'vue') return 'text/plain';
  return 'text/plain';
}

/**
 * Escapes one CSV field per RFC 4180.
 *
 * A field containing a comma, a quote or a newline is wrapped in quotes, and an
 * internal quote is doubled. Anything else is returned unchanged, so the common
 * case allocates nothing.
 */
export function escapeCsvField(value: string): string {
  let needsQuoting = false;
  let hasQuote = false;
  for (const char of value) {
    if (char === '"') {
      hasQuote = true;
      needsQuoting = true;
      break;
    }
    if (char === ',' || char === '\n' || char === '\r') needsQuoting = true;
  }
  if (!needsQuoting) return value;
  return hasQuote ? `"${value.replace(/"/g, '""')}"` : `"${value}"`;
}

/**
 * Escapes one Markdown table cell.
 *
 * Backslash first, then pipe: doing it the other way escapes the backslash that
 * the pipe escape just introduced, which is why `streamdown` documents the order
 * at `lib/table/utils.ts:137`.
 */
export function escapeMarkdownTableCell(cell: string): string {
  let needsEscaping = false;
  for (const char of cell) {
    if (char === '\\' || char === '|') {
      needsEscaping = true;
      break;
    }
  }
  if (!needsEscaping) return cell;
  return cell.replace(/\\/g, '\\\\').replace(/\|/g, '\\|');
}

/** Column alignment as `marked` reports it on a table token. */
export type TableAlign = 'left' | 'center' | 'right' | null;

/** Plain-text table content, extracted from the token before entities are built. */
export interface TableContent {
  headers: string[];
  rows: string[][];
  align: readonly TableAlign[];
}

/**
 * Serializes a table as CSV, prefixed with a UTF-8 BOM.
 *
 * Rows are `\r\n`-separated per RFC 4180.
 *
 * The BOM lives here rather than in {@link defaultSaveFile} — where `streamdown`
 * puts it — so that the guarantee survives a caller supplying its own
 * `saveFile`. Excel on Windows reads a BOM-less file in the system ANSI codepage
 * and corrupts every non-ASCII cell, and that would be a silent,
 * locale-dependent defect for anyone who replaced only the platform primitive.
 * A property of the CSV belongs to the CSV.
 */
export function tableToCsv(table: TableContent): string {
  const lines: string[] = [table.headers.map(escapeCsvField).join(',')];
  for (const row of table.rows) lines.push(row.map(escapeCsvField).join(','));
  return `\uFEFF${lines.join('\r\n')}`;
}

/**
 * Serializes a table back to GitHub-flavoured Markdown.
 *
 * The alignment row is reproduced from the token's own `align`, so a copied table
 * re-lexes to the same alignment rather than silently becoming left-aligned.
 */
export function tableToMarkdown(table: TableContent): string {
  const header = `| ${table.headers.map(escapeMarkdownTableCell).join(' | ')} |`;
  const divider = `| ${table.headers
    .map((_cell, index) => {
      switch (table.align[index]) {
        case 'left':
          return ':---';
        case 'center':
          return ':---:';
        case 'right':
          return '---:';
        default:
          return '---';
      }
    })
    .join(' | ')} |`;
  const body = table.rows.map(
    (row) =>
      `| ${table.headers
        .map((_cell, index) => escapeMarkdownTableCell(row[index] ?? ''))
        .join(' | ')} |`,
  );
  return [header, divider, ...body].join('\n');
}

/** Writes text to the clipboard, where the platform offers one. */
export function defaultWriteClipboard(text: string): void {
  const clipboard = (
    globalThis as {
      navigator?: { clipboard?: { writeText?: (t: string) => unknown } };
    }
  ).navigator?.clipboard;
  // Optional-chained rather than guarded: a document served over plain HTTP has
  // no `navigator.clipboard` at all, and a copy control that throws is worse than
  // one that silently does nothing.
  clipboard?.writeText?.(text);
}

/**
 * Downloads generated content as a file.
 *
 * Mirrors `streamdown`'s `save()` in revoking the object URL once the click has
 * been dispatched. The other borrowed detail, the UTF-8 BOM for CSV, lives in
 * {@link tableToCsv} instead — see there for why.
 */
export function defaultSaveFile(filename: string, content: string, mimeType: string): void {
  const doc = (globalThis as { document?: Document }).document;
  if (!doc?.body) return;
  // No BOM added here: `tableToCsv` already emits one, and prepending a second
  // would put a literal U+FEFF inside the first header cell.
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const anchor = doc.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  doc.body.appendChild(anchor);
  anchor.click();
  doc.body.removeChild(anchor);
  // Without this every download leaks its blob until the document unloads.
  URL.revokeObjectURL(url);
}

/**
 * A copy or download control drawn in a block's top-right corner.
 *
 * Extends `@vectojs/ui`'s `Button` rather than hand-rolling an a11y hotspot: that
 * class already projects `tag: 'button'` with a label, drives its focus ring from
 * real DOM focus/blur, and handles hover and the disabled state. The repo rule
 * against reimplementing what a `@vectojs/*` package provides applies to
 * affordances too, and a bespoke hotspot would have to re-earn focus-ring
 * behaviour `Button` already has.
 *
 * What this adds is transient success feedback. The label changes to a
 * confirmation for `FEEDBACK_MS` and then reverts, which is the only signal a copy
 * gives — nothing else about the document changes, so without it a reader cannot
 * tell a working control from a broken one.
 */
export class BlockAffordanceButton extends Button {
  /** How long the confirmation label stays up, in ms. */
  static readonly FEEDBACK_MS = 1600;

  private readonly restingLabel: string;
  private readonly successLabel: string;
  private feedbackTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    label: string,
    successLabel: string,
    private readonly act: () => void,
    opts: ButtonOptions = {},
  ) {
    super(label, { ...opts, onClick: () => this.run() });
    this.restingLabel = label;
    this.successLabel = successLabel;
    // Sized for the wider of the two labels and then left alone: a control that
    // resized when it said "Copied" would reflow the block it sits in. `Button`
    // measures `textWidth` once in its constructor, so the mutated label is
    // re-measured by hand on each transition to stay centred.
    this.width = Math.max(this.width, measureText(successLabel, this.font) + 24);
  }

  /**
   * Runs the action, then shows the confirmation.
   *
   * The action runs first and a throw propagates: a clipboard write the browser
   * rejected must not be reported as a success.
   */
  private run(): void {
    this.act();
    this.setTransientLabel(this.successLabel);
    if (this.feedbackTimer !== undefined) clearTimeout(this.feedbackTimer);
    this.feedbackTimer = setTimeout(() => {
      this.setTransientLabel(this.restingLabel);
      this.feedbackTimer = undefined;
    }, BlockAffordanceButton.FEEDBACK_MS);
  }

  private setTransientLabel(label: string): void {
    this.label = label;
    this.textWidth = measureText(label, this.font);
    this.scene?.markDirty();
  }

  /**
   * The label a reader hears is the one they see, transient confirmation
   * included, so an AT user gets the same feedback a sighted user does.
   */
  public override getA11yAttributes(): A11yAttributes {
    return { ...super.getA11yAttributes(), label: this.label };
  }

  /** Clears the pending revert so a destroyed block leaves no timer behind. */
  public override destroy(): void {
    if (this.feedbackTimer !== undefined) {
      clearTimeout(this.feedbackTimer);
      this.feedbackTimer = undefined;
    }
    super.destroy();
  }
}

/**
 * Wraps one block and positions its affordances in the top-right corner.
 *
 * A wrapper is necessary rather than adding the buttons to the block directly,
 * because both candidate parents already own their children's geometry: `Stack`
 * positions each child in flow, and `Table` recomputes `x`/`y`/`width`/`height`
 * for every child from its column widths (`Table.ts:66`). A button added to
 * either would be moved on the next layout. This owns only its own children's
 * placement and delegates its size to the block, so the surrounding document
 * lays out exactly as it did before.
 */
export class BlockWithAffordances extends UIComponent {
  /** Gap between the block's edges and the controls, in px. */
  private static readonly INSET = 8;
  /** Gap between adjacent controls, in px. */
  private static readonly GAP = 6;

  constructor(
    public readonly block: Entity,
    private readonly controls: readonly BlockAffordanceButton[],
  ) {
    super();
    this.add(block);
    for (const control of controls) this.add(control);
    this.layoutAffordances();
  }

  /**
   * Places the controls right-aligned along the block's top edge.
   *
   * Laid out right-to-left from the block's right edge so the first control in
   * the list ends up leftmost, which keeps DOM order (and therefore tab order and
   * the a11y reading order) matching the visual order.
   */
  private layoutAffordances(): void {
    this.width = this.block.width;
    this.height = this.block.height;
    let right = this.block.width - BlockWithAffordances.INSET;
    for (let i = this.controls.length - 1; i >= 0; i--) {
      const control = this.controls[i];
      control.x = right - control.width;
      control.y = BlockWithAffordances.INSET;
      right = control.x - BlockWithAffordances.GAP;
    }
  }

  /**
   * Re-places the controls after the block's own box changed.
   *
   * Called by the owner when a block is resized or its content grew; the controls
   * are anchored to the right edge, so a width change moves them.
   */
  public refreshAffordances(): void {
    this.layoutAffordances();
    this.scene?.markDirty();
  }

  /** The wrapper is a pass-through: its size is the block's size. */
  public override getLayoutControlledProperties(): ReadonlyArray<LayoutControlledProperty> {
    return ['x', 'y'];
  }

  /**
   * Projected as a group so assistive technology reports one labelled region
   * containing the block and its controls, rather than two unrelated siblings.
   */
  public getA11yAttributes(): A11yAttributes {
    return { role: 'group', pointerEvents: 'none' };
  }

  public render(): void {
    /* invisible — the block paints itself, the buttons paint themselves */
  }
}

/**
 * Extracts plain-text table content from a `marked` table token.
 *
 * Reads the token rather than the built `Table` entity because the entity holds
 * `RichText` children, not strings — reconstructing cell text from spans would
 * have to reverse the inline formatting, and the token still has the source.
 *
 * `cell.text` is the cell's raw inline Markdown, which is what a copy should
 * preserve: `**bold**` copied out of a table and pasted into another Markdown
 * document should still be bold.
 */
export function tableContentOf(token: {
  header: ReadonlyArray<{ text: string }>;
  rows: ReadonlyArray<ReadonlyArray<{ text: string }>>;
  align: readonly TableAlign[];
}): TableContent {
  return {
    headers: token.header.map((cell) => cell.text),
    rows: token.rows.map((row) => row.map((cell) => cell.text)),
    align: token.align,
  };
}
