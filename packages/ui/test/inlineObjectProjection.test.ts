// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { OBJECT_REPLACEMENT } from '@vectojs/core';
import { RichText } from '../src/RichText';

/** A paragraph with one labelled inline object in the middle. */
function withInlineObject(alt: string | undefined, maxWidth = 400): RichText {
  return new RichText(
    [
      { text: 'Inline math ' },
      { text: OBJECT_REPLACEMENT, object: { width: 40, height: 12, alt } },
      { text: ' inside a sentence.' },
    ],
    { font: '16px sans-serif', maxWidth },
  );
}

/** What the DOM would end up holding, per Scene's projection sync. */
function domText(rich: RichText): string {
  const projection = rich.getContentProjection();
  if (!projection) return '';
  const lines = projection.lines;
  if (!lines || lines.length === 0) return projection.text;
  return lines
    .map((line, index) => {
      const body = line.runs?.length ? line.runs.map((run) => run.text).join('') : line.text;
      const separator = line.separatorAfter ?? (index < lines.length - 1 ? '\n' : '');
      return body + separator;
    })
    .join('');
}

describe('RichText inline-object projection', () => {
  it('projects the alt rather than the U+FFFC sentinel', () => {
    const projection = withInlineObject('E = mc^2').getContentProjection();
    expect(projection).not.toBeNull();
    expect(projection!.text).toBe('Inline math E = mc^2 inside a sentence.');
    expect(projection!.text).not.toContain(OBJECT_REPLACEMENT);
  });

  it('keeps the accessible name and the projection in agreement', () => {
    const rich = withInlineObject('E = mc^2');
    // Before this fix these two disagreed: `getA11yAttributes` was already correct
    // while a real `Range` copy of the projection yielded the invisible sentinel.
    expect(rich.getA11yAttributes().label).toBe('Inline math E = mc^2 inside a sentence.');
    expect(rich.getContentProjection()!.text).toBe(rich.getA11yAttributes().label);
  });

  it('emits no sentinel in any line, run, or separator', () => {
    const projection = withInlineObject('E = mc^2', 160).getContentProjection()!;
    expect(projection.lines!.length).toBeGreaterThan(1);
    for (const line of projection.lines!) {
      expect(line.text).not.toContain(OBJECT_REPLACEMENT);
      expect(line.separatorAfter ?? '').not.toContain(OBJECT_REPLACEMENT);
      for (const run of line.runs ?? []) {
        expect(run.text).not.toContain(OBJECT_REPLACEMENT);
      }
    }
  });

  it('keeps projection.text equal to what the DOM assembles', () => {
    // Scene dev-mode warns on a mismatch between `projection.text` and the DOM's
    // `textContent`, and `preserveContentSelectionAcrossRebuild` snapshots caret
    // offsets against that same DOM text. Substituting in only some of the four
    // emission points would desynchronise them.
    for (const width of [400, 240, 160, 120]) {
      const rich = withInlineObject('E = mc^2', width);
      expect(domText(rich)).toBe(rich.getContentProjection()!.text);
    }
  });

  it('contributes nothing for an object with no alt', () => {
    const projection = withInlineObject(undefined).getContentProjection()!;
    // Matches `accessibleText`: an unlabelled decorative object is better absent
    // from a copy than present as an invisible character.
    expect(projection.text).toBe('Inline math  inside a sentence.');
    expect(projection.text).not.toContain(OBJECT_REPLACEMENT);
  });

  it('handles a multi-character alt without shifting later text', () => {
    // The reason this could not be a swap to `accessibleText` at the top of
    // `getContentProjection`: an alt of length != 1 shifts every later source
    // offset, so the line slices would desynchronise from the laid-out glyphs.
    const long = 'a considerably longer alternative label';
    const projection = withInlineObject(long)!.getContentProjection()!;
    expect(projection.text).toBe(`Inline math ${long} inside a sentence.`);
    // The tail survived intact and exactly once — the failure mode of a bad offset
    // mapping is a duplicated or truncated tail.
    expect(projection.text.match(/ inside a sentence\./g)).toHaveLength(1);
  });

  it('handles an alt containing a newline without breaking line assembly', () => {
    const rich = new RichText(
      [
        { text: 'before ' },
        {
          text: OBJECT_REPLACEMENT,
          object: { width: 20, height: 12, alt: 'x\ny' },
        },
        { text: ' after' },
      ],
      { font: '16px sans-serif', maxWidth: 400 },
    );
    expect(rich.getContentProjection()!.text).toBe('before x\ny after');
    expect(domText(rich)).toBe(rich.getContentProjection()!.text);
  });

  it('projects two objects on one line', () => {
    const rich = new RichText(
      [
        { text: 'a ' },
        {
          text: OBJECT_REPLACEMENT,
          object: { width: 20, height: 12, alt: 'ONE' },
        },
        { text: ' b ' },
        {
          text: OBJECT_REPLACEMENT,
          object: { width: 20, height: 12, alt: 'TWO' },
        },
        { text: ' c' },
      ],
      { font: '16px sans-serif', maxWidth: 400 },
    );
    expect(rich.getContentProjection()!.text).toBe('a ONE b TWO c');
    expect(domText(rich)).toBe(rich.getContentProjection()!.text);
  });

  it('projects an object at the very start and end of the text', () => {
    const rich = new RichText(
      [
        {
          text: OBJECT_REPLACEMENT,
          object: { width: 20, height: 12, alt: 'HEAD' },
        },
        { text: ' middle ' },
        {
          text: OBJECT_REPLACEMENT,
          object: { width: 20, height: 12, alt: 'TAIL' },
        },
      ],
      { font: '16px sans-serif', maxWidth: 400 },
    );
    expect(rich.getContentProjection()!.text).toBe('HEAD middle TAIL');
    expect(domText(rich)).toBe(rich.getContentProjection()!.text);
  });

  it('still returns null for genuinely empty content', () => {
    expect(new RichText([], { font: '16px sans-serif' }).getContentProjection()).toBeNull();
    expect(
      new RichText([{ text: '' }], {
        font: '16px sans-serif',
      }).getContentProjection(),
    ).toBeNull();
  });

  it('returns a projection for an unlabelled-object-only paragraph', () => {
    // Emptiness is decided on the source, not the projected text: this paragraph
    // projects '' but still occupies layout, and returning null here would make
    // Scene release and recreate the DOM node.
    const rich = new RichText([{ text: OBJECT_REPLACEMENT, object: { width: 20, height: 12 } }], {
      font: '16px sans-serif',
      maxWidth: 400,
    });
    const projection = rich.getContentProjection();
    expect(projection).not.toBeNull();
    expect(projection!.text).toBe('');
  });

  it('leaves object-free text byte-identical', () => {
    const plain = new RichText([{ text: 'No objects here at all.' }], {
      font: '16px sans-serif',
      maxWidth: 400,
    });
    expect(plain.getContentProjection()!.text).toBe('No objects here at all.');
    expect(domText(plain)).toBe('No objects here at all.');
  });

  it('substitutes in justified positioned runs too', () => {
    const rich = new RichText(
      [
        { text: 'Inline math ' },
        {
          text: OBJECT_REPLACEMENT,
          object: { width: 40, height: 12, alt: 'E = mc^2' },
        },
        {
          text: ' inside a sentence that wraps across more than one line for justify.',
        },
      ],
      { font: '16px sans-serif', maxWidth: 200, textAlign: 'justify' },
    );
    const projection = rich.getContentProjection()!;
    const runText = projection
      .lines!.flatMap((line) => line.runs ?? [])
      .map((run) => run.text)
      .join('');
    expect(runText).toContain('E = mc^2');
    expect(runText).not.toContain(OBJECT_REPLACEMENT);
  });
});
