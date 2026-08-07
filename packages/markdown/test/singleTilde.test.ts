// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { marked } from 'marked';
import { Markdown } from '../src/Markdown';

/**
 * A single-tilde run (`H~2~O`) must not render struck through.
 *
 * ## What the defect was
 *
 * `marked`'s GFM tokenizer emits a `del` token for a SINGLE-tilde run as well as
 * for the double-tilde strikethrough it is meant for. Measured against
 * marked@18.0.7:
 *
 * | Source        | Token                            |
 * | ------------- | -------------------------------- |
 * | `~~gone~~`    | `del`, `raw: '~~gone~~'`         |
 * | `~2~`         | `del`, `raw: '~2~'`              |
 *
 * `text` is `gone` / `2` in both cases, so the token type and text cannot tell
 * them apart — only `raw` can. `collectSpans`' `del` arm applied `lineThrough`
 * unconditionally, so `H~2~O` painted the `2` with a strikethrough and a reader
 * saw H2̶O.
 *
 * That was categorically worse than the constructs this renderer simply does not
 * support (see `unsupportedSyntax.test.ts`). Those fall back to visible literal
 * source, which a reader can interpret. This one silently changed meaning with no
 * hint that subscript was intended.
 *
 * ## What it does now, and what it still does not
 *
 * A single-tilde run re-emits its `~` delimiters as literal characters and
 * recurses **unstruck**, so the source stays visible and inner markup still
 * renders. It is NOT subscript: `TextStyle` has no baseline-shift field, so a
 * lowered run is not expressible at all today — the same constraint that forced
 * the footnote marker to signal by size alone. See
 * `forge/decisions/markdown-syntax-coverage-2026-08.md`.
 *
 * ## Why the strikethrough controls are load-bearing
 *
 * `~~x~~` is supported and must keep working. Every assertion here that pins the
 * single-tilde behaviour has a double-tilde counterpart, because a "fix" that
 * stopped striking BOTH forms would satisfy the subscript assertions alone while
 * silently deleting a shipped feature.
 *
 * ## Sabotage sweep
 *
 * Each gate was observed failing for the right reason (`tmp/agents/
 * ctx0241-sabotage.sh`), since a passing test proves nothing until it has:
 *
 * | Sabotage                                  | Failures                    |
 * | ----------------------------------------- | --------------------------- |
 * | `isStrikethrough = true` (the old defect) | 8 single-tilde assertions   |
 * | discriminator loosened to `'~'`           | 8 single-tilde assertions   |
 * | opening `~` not emitted                   | 7 round-trip assertions     |
 * | `isStrikethrough = false`                 | **5 strikethrough controls** |
 * | `lineThrough` dropped from the recursion  | **4 strikethrough controls** |
 * | every `~` stripped in `decodeEntities`    | 3 boundary assertions       |
 *
 * The last row is why the boundary group exists: stripping tildes from text is
 * the obvious wrong fix, and it satisfies every subscript assertion above while
 * eating escaped tildes and the contents of code spans.
 *
 * The one assertion no sabotage can break is the lexer pin, which asserts
 * `marked`'s behaviour rather than this renderer's. That is its job: it fails
 * only if a future `marked` changes, which is exactly when this arm needs
 * revisiting.
 */

HTMLCanvasElement.prototype.getContext = (() => null) as never;

/** Every span in the tree, flattened, with its style. */
function allSpans(md: Markdown): Array<{ text: string; style?: Record<string, unknown> }> {
  const out: Array<{ text: string; style?: Record<string, unknown> }> = [];
  const walk = (entity: { children?: unknown[] }): void => {
    const spans = (
      entity as {
        spans?: Array<{ text: string; style?: Record<string, unknown> }>;
      }
    ).spans;
    for (const span of spans ?? []) out.push(span);
    for (const child of entity.children ?? []) walk(child as { children?: unknown[] });
  };
  walk(md as unknown as { children?: unknown[] });
  return out;
}

/** All projected text, spans and plain `Text` entities alike. */
function projectedText(md: Markdown): string {
  let out = '';
  const walk = (entity: { children?: unknown[] }): void => {
    const spans = (entity as { spans?: Array<{ text?: string }> }).spans;
    for (const span of spans ?? []) out += span.text ?? '';
    const withText = entity as { text?: unknown };
    if (typeof withText.text === 'string') out += withText.text;
    for (const child of entity.children ?? []) walk(child as { children?: unknown[] });
  };
  walk(md as unknown as { children?: unknown[] });
  return out;
}

/** The text of every span carrying `lineThrough`. */
function struckTexts(md: Markdown): string[] {
  return allSpans(md)
    .filter((s) => s.style?.lineThrough === true)
    .map((s) => s.text);
}

describe('single-tilde lexing (the upstream cause)', () => {
  it('marked emits del for a single-tilde run, indistinguishable by type or text', () => {
    // Pins the upstream behaviour this fix exists to work around. If a future
    // marked stops emitting `del` for `~2~`, this fails and the arm below can go.
    const single = (
      marked.lexer('H~2~O')[0] as {
        tokens: Array<{ type: string; raw: string }>;
      }
    ).tokens;
    const double = (marked.lexer('a ~~gone~~ b')[0] as { tokens: Array<{ type: string }> }).tokens;
    expect(single.map((t) => t.type)).toEqual(['text', 'del', 'text']);
    expect(double.map((t) => t.type)).toEqual(['text', 'del', 'text']);
    // `raw` is the only discriminator.
    expect(single[1].raw).toBe('~2~');
  });
});

describe('single-tilde renders literal source, not strikethrough', () => {
  it('does not strike H~2~O', () => {
    expect(struckTexts(new Markdown('H~2~O', { width: 600 }))).toEqual([]);
  });

  it('keeps the tildes visible so the reader sees what was written', () => {
    // The honest fallback: a reader can tell subscript was intended. Round-tripping
    // the source is the whole point — without the delimiters, `H2O` would read as
    // correct prose and the lost markup would be undetectable.
    expect(projectedText(new Markdown('H~2~O', { width: 600 }))).toBe('H~2~O');
  });

  it('emits the delimiters as their own spans around the content', () => {
    const spans = allSpans(new Markdown('H~2~O', { width: 600 }));
    expect(spans.map((s) => s.text)).toEqual(['H', '~', '2', '~', 'O']);
    // No span carries a style at all: an empty object would change the paragraph
    // memo key for every document containing a tilde.
    expect(spans.every((s) => s.style === undefined)).toBe(true);
  });

  it('does not strike a single-tilde run that is a whole word', () => {
    // `a~b~c` is the intraword form; `~2~` in `H~2~O` is the same shape. Both lex
    // to `del`, so both must be covered.
    expect(struckTexts(new Markdown('a~b~c', { width: 600 }))).toEqual([]);
    expect(projectedText(new Markdown('a~b~c', { width: 600 }))).toBe('a~b~c');
  });
});

describe('double-tilde strikethrough still works (controls)', () => {
  it('strikes ~~gone~~', () => {
    // THE load-bearing control. A fix that removed the `lineThrough` arm outright
    // would pass every assertion above and silently unship GFM strikethrough.
    expect(struckTexts(new Markdown('a ~~gone~~ b', { width: 600 }))).toEqual(['gone']);
  });

  it('does not print the ~~ delimiters', () => {
    expect(projectedText(new Markdown('a ~~gone~~ b', { width: 600 }))).toBe('a gone b');
  });

  it('strikes inner markup inside a strikethrough', () => {
    // `~~*em*~~` recurses, so the em span must carry BOTH styles.
    const spans = allSpans(new Markdown('~~*em*~~', { width: 600 }));
    expect(spans).toHaveLength(1);
    expect(spans[0].text).toBe('em');
    expect(spans[0].style).toMatchObject({ lineThrough: true, italic: true });
  });
});

describe('the two forms in one document', () => {
  it('strikes only the double-tilde run', () => {
    const md = new Markdown('H~2~O and ~~del~~', { width: 600 });
    expect(struckTexts(md)).toEqual(['del']);
    expect(projectedText(md)).toBe('H~2~O and del');
  });
});

describe('inner markup and inherited style', () => {
  it('renders emphasis inside a single-tilde run', () => {
    // Recursing rather than dumping `raw` is what makes this work: `~*em*~` keeps
    // its emphasis instead of printing the asterisks.
    const spans = allSpans(new Markdown('~*em*~', { width: 600 }));
    expect(spans.map((s) => s.text)).toEqual(['~', 'em', '~']);
    expect(spans[1].style).toMatchObject({ italic: true });
    expect(spans[1].style?.lineThrough).toBeUndefined();
  });

  it('carries the surrounding run style onto the literal delimiters', () => {
    // Inside `**…**` the tildes are bold like the prose around them, rather than
    // reverting to body style and looking like a rendering glitch.
    const spans = allSpans(new Markdown('**H~2~O**', { width: 600 }));
    expect(spans.map((s) => s.text)).toEqual(['H', '~', '2', '~', 'O']);
    expect(spans.every((s) => s.style?.bold === true)).toBe(true);
    expect(spans.every((s) => s.style?.lineThrough === undefined)).toBe(true);
  });

  it('keeps a nested single-tilde run struck when it sits inside a strikethrough', () => {
    // `~~a ~b~ c~~` lexes as an outer `del` containing an inner `del`. The inner
    // tildes are CONTENT of a struck region, so they inherit `lineThrough` — the
    // fix suppresses the arm's own striking, not inherited striking.
    const md = new Markdown('~~a ~b~ c~~', { width: 600 });
    expect(projectedText(md)).toBe('a ~b~ c');
    expect(allSpans(md).every((s) => s.style?.lineThrough === true)).toBe(true);
  });
});

describe('constructs that were never del tokens are untouched', () => {
  it('leaves an escaped tilde as a literal character', () => {
    expect(projectedText(new Markdown('H\\~2\\~O', { width: 600 }))).toBe('H~2~O');
    expect(struckTexts(new Markdown('H\\~2\\~O', { width: 600 }))).toEqual([]);
  });

  it('leaves tildes inside inline code alone', () => {
    const md = new Markdown('`~x~`', { width: 600 });
    expect(projectedText(md)).toBe('~x~');
    expect(struckTexts(md)).toEqual([]);
  });

  it('leaves an unpaired tilde alone', () => {
    // `~~a~` and `a ~ b` never reach the `del` arm; asserted so a future regex
    // change to the arm cannot start claiming them.
    expect(projectedText(new Markdown('a ~ b', { width: 600 }))).toBe('a ~ b');
    expect(struckTexts(new Markdown('~~a~', { width: 600 }))).toEqual([]);
  });
});
