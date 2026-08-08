/**
 * The construct corpus the showcase page renders and the screenshot gate shoots.
 *
 * One section per construct GROUP, not one per construct: a screenshot is only
 * useful if a human can see what changed in it, and a single 3000px-tall image
 * of every construct at once answers "did anything move" with "somewhere, yes".
 * Sectioning also means a regression names itself — `spans` drifting while
 * `containers` holds is a different bug from the reverse.
 *
 * Sourced from the same construct list the `PX-0524` cluster shipped against
 * (see `packages/markdown/test/*.test.ts` and the four `*-ink.e2e.ts` suites),
 * plus the pre-existing constructs those suites never covered visually. The
 * ink suites assert SAMPLED PIXELS — `bottomInkRow`, corner RGBA,
 * `maxRunFraction` — which prove a draw path fires but not what it looks like;
 * this corpus is the other half, and is why every section deliberately places
 * a construct next to plain prose rather than alone: a baseline that is 2px off
 * or a highlight that is invisible against one preset's surface is only visible
 * in contrast.
 *
 * Kept free of `$$` block math on purpose. Block math loads `@vectojs/tex`
 * lazily and typesets asynchronously, so a page containing it is not ready when
 * its layout settles — it is ready some indeterminate time later. That turns
 * every capture into a race the READY signal cannot express (the same hazard
 * `lazy-math.e2e.ts` handles with an explicit await). Inline `$x$` is included
 * because its fallback path is synchronous; a math-specific showcase belongs in
 * its own page with its own readiness gate.
 */

/** One captured section: a stable id, a heading, and its Markdown source. */
export interface ShowcaseSection {
  /** Stable, filename-safe id. Baseline images are keyed on it. */
  id: string;
  /** Human label drawn above the section. */
  title: string;
  /** Markdown source rendered for this section. */
  source: string;
}

export const SHOWCASE_SECTIONS: readonly ShowcaseSection[] = [
  {
    id: 'headings',
    title: 'Headings and rules',
    source: [
      '# h1 Heading',
      '## h2 Heading',
      '### h3 Heading',
      '#### h4 Heading',
      '##### h5 Heading',
      '###### h6 Heading',
      '',
      'Body text after the heading run, for scale comparison.',
      '',
      '---',
      '',
      'Text below a horizontal rule.',
    ].join('\n'),
  },
  {
    id: 'spans',
    title: 'Span styles',
    source: [
      'Plain, **bold**, *italic*, ***bold italic***, `inline code`,',
      '~~struck through~~, ++inserted++, and ==highlighted== text.',
      '',
      'Water is H~2~O and the 19^th^ century, both against plain digits 2 and 19',
      'so a baseline shift is visible as a shift.',
      '',
      'A single tilde ~like this~ must NOT strike through — it is subscript.',
      '',
      'Emoji shortcodes :wink: :heart: :rocket: beside literal text.',
    ].join('\n'),
  },
  {
    id: 'typography',
    title: 'Typographic replacements',
    source: [
      'Enable the typographer toggle to see these change.',
      '',
      '(c) (r) (tm) +- and an ellipsis...',
      '',
      'An en dash -- and an em dash --- between words.',
      '',
      '"Double quotes" and \'single quotes\' around words.',
    ].join('\n'),
  },
  {
    id: 'containers',
    title: 'Fenced containers',
    source: [
      ':::note',
      'A note container, with **bold** inside it.',
      ':::',
      '',
      ':::tip',
      'A tip container.',
      ':::',
      '',
      ':::warning',
      'A warning container.',
      ':::',
      '',
      ':::danger',
      'A danger container.',
      ':::',
      '',
      ':::unknownkind',
      'An unrecognised kind falls back to the neutral default colour.',
      ':::',
    ].join('\n'),
  },
  {
    id: 'quotes-lists',
    title: 'Quotes and lists',
    source: [
      '> A blockquote with `code` and **bold**.',
      '>',
      '> > A nested blockquote, to show the accent bars stack.',
      '',
      '- Unordered one',
      '- Unordered two',
      '  - Nested item',
      '',
      '1. Ordered one',
      '2. Ordered two',
      '',
      '- [ ] An open task',
      '- [x] A done task',
    ].join('\n'),
  },
  {
    id: 'code-table',
    title: 'Code and tables',
    source: [
      '```ts',
      'export function greet(name: string): string {',
      '  // A comment, a string, and a number: 42',
      '  return `hello ${name}`;',
      '}',
      '```',
      '',
      '| Construct | Supported | Notes |',
      '| --------- | :-------: | ----: |',
      '| Tables    | yes       | right |',
      '| Alignment | yes       |  1.00 |',
    ].join('\n'),
  },
  {
    id: 'links-abbr-notes',
    title: 'Links, abbreviations, footnotes',
    source: [
      'A [link](https://vectojs.org), an autolink <https://vectojs.org>,',
      'and a [titled link](https://vectojs.org "The title").',
      '',
      'The HTML spec and the CSS spec both matter here.',
      '',
      '*[HTML]: HyperText Markup Language',
      '*[CSS]: Cascading Style Sheets',
      '',
      'A claim needing a source[^src] and a second one[^more].',
      '',
      '[^src]: The first note.',
      '[^more]: The second note, which runs long enough to wrap onto another',
      '    line so a multi-paragraph body is visible.',
      '',
      '    A second paragraph inside the same footnote definition.',
      '',
      'Inline math $E = mc^2$ sits on the prose baseline.',
    ].join('\n'),
  },
];

/** Look one section up by id, or `null`. */
export function sectionById(id: string): ShowcaseSection | null {
  return SHOWCASE_SECTIONS.find((section) => section.id === id) ?? null;
}
