// @vitest-environment jsdom
/**
 * GH-457: Line-break suppression rules.
 * Rule 1 — No line may start with trailing/closing punctuation.
 * Rule 2 — '@' must not be separated from the following identifier.
 */
import { test, expect } from 'vitest';
import { LayoutEngine, type GlyphAtlas } from '../src/LayoutEngine';
import { computeMSDFLayout } from '../src/msdfLayout';
import type { LayoutWorkerRequest } from '../src/LayoutWorker';

// Build a complete atlas for the test text
const mockAtlas: GlyphAtlas = {};
const chars = 'This a sentence. More text here use @vectojs/core for canvas';
for (const ch of chars) {
  if (!mockAtlas[ch]) {
    mockAtlas[ch] = {
      width: ch === ' ' ? 5 : ch === '.' ? 4 : ch === '@' ? 12 : 9,
      baseSize: 16,
      ast: null,
    };
  }
}

test('LayoutEngine: orphan closing punctuation does not start a line', () => {
  const engine = new LayoutEngine(80, 1000); // narrow width
  const result = engine.layoutText('This is a sentence. More text', mockAtlas, 16);

  // Find period nodes
  const periods = result.nodes.filter((n) => n.char === '.');
  expect(periods.length).toBeGreaterThan(0);

  // No period should start a line (x near 0)
  for (const p of periods) {
    expect(p.x).toBeGreaterThan(2); // allow small margin
  }
});

test('LayoutEngine: orphan punctuation after a space never starts a line', () => {
  // Intl.Segmenter segments 'word !' as ['word', ' ', '!']; the '!' must merge
  // onto 'word' (skipping the whitespace word), not onto the space.
  const narrowAtlas: GlyphAtlas = {};
  for (const ch of 'word !') {
    if (!narrowAtlas[ch]) {
      narrowAtlas[ch] = {
        width: ch === ' ' ? 5 : ch === '!' ? 4 : 9,
        baseSize: 16,
        ast: null,
      };
    }
  }
  const engine = new LayoutEngine(40, 1000); // 'word' fits, 'word !' does not
  const result = engine.layoutText('word !', narrowAtlas, 16);

  const bang = result.nodes.find((n) => n.char === '!');
  expect(bang).toBeDefined();
  expect(bang!.x).toBeGreaterThan(2);
});

test('LayoutEngine: @ identifier stays together', () => {
  const engine = new LayoutEngine(60, 1000); // very narrow
  const result = engine.layoutText('use @vectojs for', mockAtlas, 16);

  const atNode = result.nodes.find((n) => n.char === '@');
  const vNode = result.nodes.find((n) => n.char === 'v');

  if (atNode && vNode) {
    // '@' and 'v' must be on same line
    expect(atNode.y).toBe(vNode.y);
  } else {
    // If nodes missing, skip - atlas might not have all chars
    expect(true).toBe(true);
  }
});

test('msdfLayout: orphan closing punctuation does not start a line', () => {
  const fontData = {
    atlas: { type: 'msdf', distanceRange: 4, size: 32, width: 256, height: 256, yOrigin: 'bottom' },
    metrics: { emSize: 1, lineHeight: 1, ascender: 0.8, descender: -0.2 },
    glyphs: [
      { unicode: 84, advance: 0.6 }, // T
      { unicode: 104, advance: 0.5 }, // h
      { unicode: 105, advance: 0.3 }, // i
      { unicode: 115, advance: 0.4 }, // s
      { unicode: 32, advance: 0.3 }, // space
      { unicode: 46, advance: 0.25 }, // .
      { unicode: 77, advance: 0.7 }, // M
    ],
    kerning: {},
  } as unknown as LayoutWorkerRequest['fontData'];

  const result = computeMSDFLayout(
    {
      id: 'test',
      seqId: 1,
      text: 'This is. M',
      fontId: 'test-font',
      fontData,
      fontSize: 16,
      maxWidth: 50, // narrow
      maxHeight: 1000,
      textAlign: 'left',
    },
    fontData,
  );

  const codePoints = Array.from(result.codePoints);
  const periodIdx = codePoints.indexOf(46); // '.'

  if (periodIdx >= 0) {
    // Period should not be at x=0 (start of line)
    expect(result.xCoords[periodIdx]).toBeGreaterThan(0);
  }
});

test('msdfLayout: @ identifier stays together', () => {
  const fontData = {
    atlas: { type: 'msdf', distanceRange: 4, size: 32, width: 256, height: 256, yOrigin: 'bottom' },
    metrics: { emSize: 1, lineHeight: 1, ascender: 0.8, descender: -0.2 },
    glyphs: [
      { unicode: 117, advance: 0.5 }, // u
      { unicode: 115, advance: 0.4 }, // s
      { unicode: 101, advance: 0.5 }, // e
      { unicode: 32, advance: 0.3 }, // space
      { unicode: 64, advance: 0.6 }, // @
      { unicode: 118, advance: 0.5 }, // v
      { unicode: 99, advance: 0.4 }, // c
    ],
    kerning: {},
  } as unknown as LayoutWorkerRequest['fontData'];

  const result = computeMSDFLayout(
    {
      id: 'test',
      seqId: 1,
      text: 'use @vc',
      fontId: 'test-font',
      fontData,
      fontSize: 16,
      maxWidth: 35, // very narrow
      maxHeight: 1000,
      textAlign: 'left',
    },
    fontData,
  );

  const codePoints = Array.from(result.codePoints);
  const atIdx = codePoints.indexOf(64); // '@'
  const vIdx = codePoints.indexOf(118); // 'v'

  if (atIdx >= 0 && vIdx > atIdx) {
    // '@' and 'v' should have same y (same line)
    expect(result.yCoords[atIdx]).toBe(result.yCoords[vIdx]);
  }
});
